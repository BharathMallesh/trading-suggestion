import { describe } from 'vitest';
import { storageContract } from '../helpers/storage-contract';
import { FakeStorage } from '../helpers/fake-storage';
import { OpfsStorage } from '../../src/storage/opfs';

storageContract('FakeStorage', async () => new FakeStorage());

// jsdom has no OPFS; this suite runs in a browser-capable runner.
// Locally it is skipped.
const hasOpfs = typeof navigator !== 'undefined' && !!(navigator as any).storage?.getDirectory;
(hasOpfs ? describe : describe.skip)('OpfsStorage', () => {
  storageContract('OPFS', () => OpfsStorage.create());
});
