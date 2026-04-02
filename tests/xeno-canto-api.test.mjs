import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildXenoCantoAnnotationSet,
    XenoCantoApiClient,
    XenoCantoApiError,
} from '../src/xenoCantoApi.js';

test('buildXenoCantoAnnotationSet fails without required fields', () => {
    const res = buildXenoCantoAnnotationSet({ metadata: {}, annotations: [] });
    assert.equal(res.ok, false);
    assert.equal(res.payload, null);
    assert.equal(res.errors.length >= 1, true);
});

test('buildXenoCantoAnnotationSet maps metadata + annotations', () => {
    const res = buildXenoCantoAnnotationSet({
        metadata: {
            xcfileno: '12345',
            project: 'Bird Study',
            annname: 'Tester',
            setname: 'Set A',
            setcreator: 'Team A',
            set_license: 'CC-BY-4.0',
        },
        annotations: [
            {
                Selection: '1',
                beginTime: 0.25,
                endTime: 0.8,
                highFreq: 6000,
                lowFreq: 1500,
                scientificName: 'Corvus corax',
                soundType: 'call',
            },
        ],
        apiVersion: 'Audio Workbench Test',
    });

    assert.equal(res.ok, true);
    assert.equal(res.errors.length, 0);
    assert.equal(res.payload.annotations.length, 1);
    assert.equal(res.payload.annotations[0].xc_nr, '12345');
    assert.equal(res.payload.annotations[0].scientific_name, 'Corvus corax');
    assert.equal(res.payload.annotation_software_name_and_version, 'Audio Workbench Test');
});

test('XenoCantoApiClient retries once on retryable status and succeeds', async () => {
    let calls = 0;
    const fetchMock = async () => {
        calls += 1;
        if (calls === 1) {
            return {
                ok: false,
                status: 500,
                statusText: 'Server Error',
                text: async () => JSON.stringify({ errors: ['temporary failure'] }),
            };
        }
        return {
            ok: true,
            status: 200,
            statusText: 'OK',
            text: async () => JSON.stringify({ message: 'uploaded', warnings: [] }),
        };
    };

    const client = new XenoCantoApiClient({
        apiKey: 'k',
        retries: 1,
        retryDelayMs: 1,
        fetchImpl: fetchMock,
    });

    const result = await client.uploadAnnotationSet({ annotations: [{}] });
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(calls, 2);
});

test('XenoCantoApiClient throws typed error on non-retryable failure', async () => {
    const fetchMock = async () => ({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => JSON.stringify({ errors: ['invalid payload'] }),
    });

    const client = new XenoCantoApiClient({
        apiKey: 'k',
        retries: 2,
        retryDelayMs: 1,
        fetchImpl: fetchMock,
    });

    await assert.rejects(
        () => client.uploadAnnotationSet({ annotations: [] }),
        (err) => {
            assert.equal(err instanceof XenoCantoApiError, true);
            assert.equal(err.status, 400);
            assert.equal(err.retryable, false);
            return true;
        },
    );
});
