/*--------------------------------------------------------------------------------------------- 
 *  Copyright (c) Microsoft Corporation. All rights reserved. 
 *  Licensed under the MIT License. See License.txt in the project root for license information. 
 *--------------------------------------------------------------------------------------------*/ 

export default async function poll<T>(getValue: () => T, duration: number, step: number): Promise<T> {
    while (duration > 0) {
        let value = await getValue();

        if(Array.isArray(value) && value.length > 0) {
            return value;
        }

        if (!Array.isArray(value) && value) {
            return value;
        }

        await sleep(step);

        duration -= step;
    }

    throw new Error("Polling did not succeed within the alotted duration.");
}

async function sleep(ms = 0) {
    return new Promise(r => setTimeout(r, ms));
}