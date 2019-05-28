/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OmniSharpServer } from '../omnisharp/server';
import AbstractSupport from './abstractProvider';
import * as protocol from '../omnisharp/protocol';
import * as serverUtils from '../omnisharp/utils';
import { toRange } from '../omnisharp/typeConversion';
import * as vscode from 'vscode';
import CompositeDisposable from '../CompositeDisposable';
import { IDisposable } from '../Disposable';
import { isVirtualCSharpDocument } from './virtualDocumentTracker';
import { TextDocument } from '../vscodeAdapter';
import OptionProvider from '../observers/OptionProvider';

export class Advisor {

    private _disposable: CompositeDisposable;
    private _server: OmniSharpServer;
    private _packageRestoreCounter: number = 0;
    private _projectSourceFileCounts: { [path: string]: number } = Object.create(null);

    constructor(server: OmniSharpServer, private optionProvider: OptionProvider) {
        this._server = server;

        let d1 = server.onProjectChange(this._onProjectChange, this);
        let d2 = server.onProjectAdded(this._onProjectAdded, this);
        let d3 = server.onProjectRemoved(this._onProjectRemoved, this);
        let d4 = server.onBeforePackageRestore(this._onBeforePackageRestore, this);
        let d5 = server.onPackageRestore(this._onPackageRestore, this);
        this._disposable = new CompositeDisposable(d1, d2, d3, d4, d5);
    }

    public dispose() {
        this._disposable.dispose();
    }

    public shouldValidateFiles(): boolean {
        return this._isServerStarted()
            && !this._isRestoringPackages();
    }

    public shouldValidateProject(): boolean {
        return this._isServerStarted()
            && !this._isRestoringPackages()
            && !this._isOverFileLimit();
    }

    private _updateProjectFileCount(path: string, fileCount: number): void {
        this._projectSourceFileCounts[path] = fileCount;
    }

    private _addOrUpdateProjectFileCount(info: protocol.ProjectInformationResponse): void {
        if (info.DotNetProject && info.DotNetProject.SourceFiles) {
            this._updateProjectFileCount(info.DotNetProject.Path, info.DotNetProject.SourceFiles.length);
        }

        if (info.MsBuildProject && info.MsBuildProject.SourceFiles) {
            this._updateProjectFileCount(info.MsBuildProject.Path, info.MsBuildProject.SourceFiles.length);
        }
    }

    private _removeProjectFileCount(info: protocol.ProjectInformationResponse): void {
        if (info.DotNetProject && info.DotNetProject.SourceFiles) {
            delete this._projectSourceFileCounts[info.DotNetProject.Path];
        }

        if (info.MsBuildProject && info.MsBuildProject.SourceFiles) {
            delete this._projectSourceFileCounts[info.MsBuildProject.Path];
        }
    }

    private _onProjectAdded(info: protocol.ProjectInformationResponse): void {
        this._addOrUpdateProjectFileCount(info);
    }

    private _onProjectRemoved(info: protocol.ProjectInformationResponse): void {
        this._removeProjectFileCount(info);
    }

    private _onProjectChange(info: protocol.ProjectInformationResponse): void {
        this._addOrUpdateProjectFileCount(info);
    }

    private _onBeforePackageRestore(): void {
        this._packageRestoreCounter += 1;
    }

    private _onPackageRestore(): void {
        this._packageRestoreCounter -= 1;
    }

    private _isRestoringPackages(): boolean {
        return this._packageRestoreCounter > 0;
    }

    private _isServerStarted(): boolean {
        return this._server.isRunning();
    }

    private _isOverFileLimit(): boolean {
        let opts = this.optionProvider.GetLatestOptions();
        let fileLimit = opts.maxProjectFileCountForDiagnosticAnalysis;
        if (fileLimit > 0) {
            let sourceFileCount = 0;
            for (let key in this._projectSourceFileCounts) {
                sourceFileCount += this._projectSourceFileCounts[key];
                if (sourceFileCount > fileLimit) {
                    return true;
                }
            }
        }
        return false;
    }
}

export default function reportDiagnostics(server: OmniSharpServer, advisor: Advisor): IDisposable {
    return new DiagnosticsProvider(server, advisor);
}

class DiagnosticsProvider extends AbstractSupport {

    private _validationAdvisor: Advisor;
    private _disposable: CompositeDisposable;
    private _documentValidations: { [uri: string]: vscode.CancellationTokenSource } = Object.create(null);
    private _projectValidation: vscode.CancellationTokenSource;
    private _diagnostics: vscode.DiagnosticCollection;
    private _suppressHiddenDiagnostics: boolean;

    constructor(server: OmniSharpServer, validationAdvisor: Advisor) {
        super(server);

        this._validationAdvisor = validationAdvisor;
        this._diagnostics = vscode.languages.createDiagnosticCollection('csharp');
        this._suppressHiddenDiagnostics = vscode.workspace.getConfiguration('csharp').get('suppressHiddenDiagnostics', true);

        this._disposable = new CompositeDisposable(this._diagnostics,
            this._server.onPackageRestore(this._validateProject, this),
            this._server.onProjectChange(this._validateProject, this),
            this._server.onProjectDiagnosticStatus(this.onProjectAnalysis, this),
            vscode.workspace.onDidOpenTextDocument(event => this._onDocumentAddOrChange(event), this),
            vscode.workspace.onDidChangeTextDocument(event => this._onDocumentAddOrChange(event.document), this),
            vscode.workspace.onDidCloseTextDocument(this._onDocumentRemove, this),
            vscode.window.onDidChangeActiveTextEditor(event => this._onDidChangeActiveTextEditor(event), this),
            vscode.window.onDidChangeWindowState(event => this._OnDidChangeWindowState(event), this),
        );

        // Go ahead and check for diagnostics in the currently visible editors.
        for (let editor of vscode.window.visibleTextEditors) {
            let document = editor.document;
            if (this.shouldIgnoreDocument(document)) {
                continue;
            }

            this._validateDocument(document);
        }
    }

    public dispose = () => {
        if (this._projectValidation) {
            this._projectValidation.dispose();
        }

        for (let key in this._documentValidations) {
            this._documentValidations[key].dispose();
        }

        this._disposable.dispose();
    }

    private shouldIgnoreDocument(document: TextDocument) {
        if (document.languageId !== 'csharp') {
            return true;
        }

        if (document.uri.scheme !== 'file' &&
            !isVirtualCSharpDocument(document)) {
            return true;
        }

        return false;
    }

    private _OnDidChangeWindowState(windowState: vscode.WindowState): void {
        if (windowState.focused === true) {
            this._onDidChangeActiveTextEditor(vscode.window.activeTextEditor);
        }
    }

    private _onDidChangeActiveTextEditor(textEditor: vscode.TextEditor): void {
        // active text editor can be undefined.
        if (textEditor != undefined && textEditor.document != null) {
            this._onDocumentAddOrChange(textEditor.document);
        }
    }

    private _onDocumentAddOrChange(document: vscode.TextDocument): void {
        if (this.shouldIgnoreDocument(document)) {
            return;
        }

        this._validateDocument(document);
        //this._validateProject();
    }

    private onProjectAnalysis(event: protocol.ProjectDiagnosticStatus)
    {
        if(event.Status == 1)
        {
            this._validateProject();
        }
    }

    private _onDocumentRemove(document: vscode.TextDocument): void {
        let key = document.uri;
        let didChange = false;
        if (this._diagnostics.get(key)) {
            didChange = true;
            this._diagnostics.delete(key);
        }

        let keyString = key.toString();

        if (this._documentValidations[keyString]) {
            didChange = true;
            this._documentValidations[keyString].cancel();
            delete this._documentValidations[keyString];
        }
        if (didChange) {
            this._validateProject();
        }
    }

    private _validateDocument(document: vscode.TextDocument): void {
        // If we've already started computing for this document, cancel that work.
        let key = document.uri.toString();
        if (this._documentValidations[key]) {
            this._documentValidations[key].cancel();
        }

        if (!this._validationAdvisor.shouldValidateFiles()) {
            return;
        }

        let source = new vscode.CancellationTokenSource();
        let handle = setTimeout(async () => {
            try {
                let value = await serverUtils.codeCheck(this._server, { FileName: document.fileName }, source.token);
                let quickFixes = value.QuickFixes;
                // Easy case: If there are no diagnostics in the file, we can clear it quickly.
                if (quickFixes.length === 0) {
                    if (this._diagnostics.has(document.uri)) {
                        this._diagnostics.delete(document.uri);
                    }

                    return;
                }

                // (re)set new diagnostics for this document
                let diagnosticsInFile = this._mapQuickFixesAsDiagnosticsInFile(quickFixes);

                this._diagnostics.set(document.uri, diagnosticsInFile.map(x => x.diagnostic));
            }
            catch (error) {
                return;
            }
        }, 750);

        source.token.onCancellationRequested(() => clearTimeout(handle));
        this._documentValidations[key] = source;
    }

    private _mapQuickFixesAsDiagnosticsInFile(quickFixes: protocol.QuickFix[]): { diagnostic: vscode.Diagnostic, fileName: string }[] {
        return quickFixes
            .map(quickFix => this._asDiagnosticInFileIfAny(quickFix))
            .filter(diagnosticInFile => diagnosticInFile !== undefined);
    }

    private _validateProject(): void {
        // If we've already started computing for this project, cancel that work.
        // if (this._projectValidation) {
        //     this._projectValidation.cancel();
        // }

        if (!this._validationAdvisor.shouldValidateProject()) {
            return;
        }

        this._projectValidation = new vscode.CancellationTokenSource();
        let handle = setTimeout(async () => {
            try {
                let value = await serverUtils.codeCheck(this._server, { FileName: null }, this._projectValidation.token);

                let quickFixes = value.QuickFixes
                    .sort((a, b) => a.FileName.localeCompare(b.FileName));

                let entries: [vscode.Uri, vscode.Diagnostic[]][] = [];
                let lastEntry: [vscode.Uri, vscode.Diagnostic[]];

                for (let diagnosticInFile of this._mapQuickFixesAsDiagnosticsInFile(quickFixes)) {
                    let uri = vscode.Uri.file(diagnosticInFile.fileName);

                    if (lastEntry && lastEntry[0].toString() === uri.toString()) {
                        lastEntry[1].push(diagnosticInFile.diagnostic);
                    } else {
                        // We're replacing all diagnostics in this file. Pushing an entry with undefined for
                        // the diagnostics first ensures that the previous diagnostics for this file are
                        // cleared. Otherwise, new entries will be merged with the old ones.
                        entries.push([uri, undefined]);
                        lastEntry = [uri, [diagnosticInFile.diagnostic]];
                        entries.push(lastEntry);
                    }
                }

                // Clear diagnostics for files that no longer have any diagnostics.
                this._diagnostics.forEach((uri, diagnostics) => {
                    if (!entries.find(tuple => tuple[0].toString() === uri.toString())) {
                        this._diagnostics.delete(uri);
                    }
                });

                // replace all entries
                this._diagnostics.set(entries);
            }
            catch (error) {
                return;
            }
        }, 3000);

        // clear timeout on cancellation
        this._projectValidation.token.onCancellationRequested(() => {
            clearTimeout(handle);
        });
    }

    private _asDiagnosticInFileIfAny(quickFix: protocol.QuickFix): { diagnostic: vscode.Diagnostic, fileName: string } {
        let display = this._getDiagnosticDisplay(quickFix, this._asDiagnosticSeverity(quickFix));

        if (display.severity === "hidden") {
            return undefined;
        }

        let message = `${quickFix.Text} [${quickFix.Projects.map(n => this._asProjectLabel(n)).join(', ')}]`;

        let diagnostic = new vscode.Diagnostic(toRange(quickFix), message, display.severity);

        if (display.isFadeout) {
            diagnostic.tags = [vscode.DiagnosticTag.Unnecessary];
        }

        return { diagnostic: diagnostic, fileName: quickFix.FileName };
    }

    private _getDiagnosticDisplay(quickFix: protocol.QuickFix, severity: vscode.DiagnosticSeverity | "hidden"): { severity: vscode.DiagnosticSeverity | "hidden", isFadeout: boolean }
    {
        // CS0162 & CS8019 => Unnused using and unreachable code.
        // These hard coded values bring some goodnes of fading even when analyzers are disabled.
        let isFadeout = (quickFix.Tags && !!quickFix.Tags.find(x => x.toLowerCase() == 'unnecessary')) || quickFix.Id == "CS0162" || quickFix.Id == "CS8019";

        if (isFadeout && quickFix.LogLevel.toLowerCase() === 'hidden' || quickFix.LogLevel.toLowerCase() === 'none') {
            // Theres no such thing as hidden severity in VSCode,
            // however roslyn uses commonly analyzer with hidden to fade out things.
            // Without this any of those doesn't fade anything in vscode.
            return { severity: vscode.DiagnosticSeverity.Hint , isFadeout };
        }

        return { severity: severity, isFadeout };
    }

    private _asDiagnosticSeverity(quickFix: protocol.QuickFix): vscode.DiagnosticSeverity | "hidden" {
        switch (quickFix.LogLevel.toLowerCase()) {
            case 'error':
                return vscode.DiagnosticSeverity.Error;
            case 'warning':
                return vscode.DiagnosticSeverity.Warning;
            case 'info':
                return vscode.DiagnosticSeverity.Information;
            case 'hidden':
                if (this._suppressHiddenDiagnostics) {
                    return "hidden";
                }
                return vscode.DiagnosticSeverity.Hint;
            default:
                return "hidden";
        }
    }

    private _asProjectLabel(projectName: string): string {
        const idx = projectName.indexOf('+');
        return projectName.substr(idx + 1);
    }
}
