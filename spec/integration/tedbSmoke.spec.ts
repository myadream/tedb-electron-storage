import {ElectronStorage} from '../../src';
import {mkdtempSync, rmSync} from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Integration smoke against the real tedb Datastore (devDependency).
 * Auto-skips when tedb is not installed — the driver-level suites cover the
 * adapter contract independently.
 */
let tedb: any;
try {
    // eslint-disable-next-line
    tedb = require('tedb');
} catch (e) {
    tedb = null;
}

const describeIfTedb = tedb ? describe : describe.skip;

describeIfTedb('tedb Datastore integration smoke', () => {
    let storage: ElectronStorage;
    let rootDir: string;
    let Datastore: any;

    beforeAll(() => {
        Datastore = tedb.Datastore;
    });

    beforeEach(() => {
        rootDir = mkdtempSync(path.join(os.tmpdir(), 'tedb-int-'));
        storage = new ElectronStorage('intdb', 'users', rootDir);
    });

    afterEach(async () => {
        try {
            await storage.clear();
        } catch (e) {
            // best effort
        }
        rmSync(rootDir, {recursive: true, force: true});
    });

    const makeDb = () => new Datastore({storage});

    test('insert, find by indexed field, update, remove', async () => {
        const db = makeDb();
        await db.ensureIndex({fieldName: 'email', unique: true});
        await db.insert({_id: 'u1', email: 'a@x.com', name: 'Alice', age: 30});
        await db.insert({_id: 'u2', email: 'b@x.com', name: 'Bob', age: 40});

        const found = await db.find({email: 'a@x.com'}).exec();
        expect(found.length).toBe(1);
        expect(found[0].name).toBe('Alice');

        await db.update({email: 'a@x.com'}, {$set: {age: 31}}, {multi: false});
        const updated = await db.find({email: 'a@x.com'}).exec();
        expect(updated[0].age).toBe(31);

        await db.remove({email: 'b@x.com'});
        await db.sanitize();
        const remaining = await db.find({}).exec();
        expect(remaining.length).toBe(1);
    });

    test('documents survive a fresh Datastore on the same directory', async () => {
        const db = makeDb();
        await db.insert({_id: 'u1', email: 'a@x.com', name: 'Alice'});

        const reopened = makeDb();
        const found = await reopened.find({email: 'a@x.com'}).exec();
        expect(found.length).toBe(1);
        expect(found[0].name).toBe('Alice');
    });

    test('index persists via saveIndex and loads via insertIndex', async () => {
        const db = makeDb();
        await db.ensureIndex({fieldName: 'email', unique: true});
        await db.insert({_id: 'u1', email: 'a@x.com'});
        await db.insert({_id: 'u2', email: 'b@x.com'});
        await db.saveIndex('email');

        const reopened = makeDb();
        // fetchIndex returns the stored index JSON structure
        const saved = await storage.fetchIndex('email');
        expect(Array.isArray(saved)).toBe(true);
        expect(saved.length).toBeGreaterThan(0);
        await reopened.ensureIndex({fieldName: 'email', unique: true});
        await reopened.insertIndex('email', saved);
        const found = await reopened.find({email: 'b@x.com'}).exec();
        expect(found.length).toBe(1);
    });

    test('concurrent inserts through the Datastore stay consistent', async () => {
        const db = makeDb();
        const docs = Array.from({length: 50}, (_, i) => ({email: `u${i}@x.com`, name: `user${i}`}));
        await Promise.all(docs.map((d) => db.insert(d)));
        const all = await db.find({}).exec();
        expect(all.length).toBe(50);
        const keys = await storage.keys();
        expect(keys.length).toBe(50);
    });
});
