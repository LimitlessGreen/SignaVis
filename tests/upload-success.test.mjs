import test from 'node:test';
import assert from 'node:assert/strict';
import { accountUrlFrom } from '../src/ui/components/upload-success/upload-success.ts';

const LIVE = 'https://xeno-canto.org/api/3/upload/annotation-set';

test('account link is taken from the server message', () => {
    assert.equal(accountUrlFrom('Successfully uploaded. Visit https://xeno-canto.org/account to import.', LIVE),
        'https://xeno-canto.org/account');
    assert.equal(accountUrlFrom('Visit https://acc.xeno-canto.org/account/sets.', LIVE),
        'https://acc.xeno-canto.org/account/sets');
});

test('account link falls back to the upload server', () => {
    assert.equal(accountUrlFrom('Upload successful', 'https://acc.xeno-canto.org/api/3/upload/annotation-set'),
        'https://acc.xeno-canto.org/account');
    assert.equal(accountUrlFrom(undefined, LIVE), 'https://xeno-canto.org/account');
});
