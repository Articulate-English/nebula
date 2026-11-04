// Phase 1 gate: two clients must exchange edits over the sync Worker.
// Uses the SAME WebsocketProvider the browser client will use.
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import ws from 'ws';

const URL = process.env.SYNC_URL || 'ws://127.0.0.1:8795/sync';
const ROOM = 'spike-' + Date.now();

const opts = { WebSocketPolyfill: ws, connect: false };
const docA = new Y.Doc();
const docB = new Y.Doc();
const a = new WebsocketProvider(URL, ROOM, docA, opts);
const b = new WebsocketProvider(URL, ROOM, docB, opts);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const notesA = docA.getMap('notes');
const notesB = docB.getMap('notes');

let aSawB = false;
let bSawA = false;
notesA.observe(() => { if (notesA.get('from-b')) aSawB = true; });
notesB.observe(() => { if (notesB.get('from-a')) bSawA = true; });

const status = (p) => p.wsconnected ? 'connected' : 'connecting';

console.log('room:', ROOM);
console.log('before connect: A=%s B=%s', status(a), status(b));

a.connect();
b.connect();

// wait for both sockets
for (let i = 0; i < 40; i++) {
  await wait(250);
  if (a.wsconnected && b.wsconnected) break;
}
console.log('after connect:  A=%s B=%s', status(a), status(b));

if (!a.wsconnected || !b.wsconnected) {
  console.log('FAIL — clients never connected');
  process.exit(1);
}

// A writes, B should see it
docA.getMap('notes').set('from-a', 'hello from A');
await wait(1500);
console.log('B saw A\'s write:', bSawA, '| B.notes =', JSON.stringify(notesB.toJSON()));

// B writes, A should see it
docB.getMap('notes').set('from-b', 'hello from B');
await wait(1500);
console.log('A saw B\'s write:', aSawB, '| A.notes =', JSON.stringify(notesA.toJSON()));

// concurrent edit to the SAME key (conflict case)
docA.getMap('notes').set('shared', 'A-version');
docB.getMap('notes').set('shared', 'B-version');
await wait(1500);
const sharedA = notesA.get('shared');
const sharedB = notesB.get('shared');
console.log('conflict — A has:', sharedA, '| B has:', sharedB,
            '| identical:', sharedA === sharedB);

// a THIRD client joins later and must get the full history
const docC = new Y.Doc();
const c = new WebsocketProvider(URL, ROOM, docC, opts);
c.connect();
await wait(2000);
console.log('late joiner C sees:', JSON.stringify(docC.getMap('notes').toJSON()),
            '| connected:', c.wsconnected);

const pass = bSawA && aSawB && sharedA === sharedB &&
             docC.getMap('notes').get('from-a') === 'hello from A' &&
             docC.getMap('notes').get('from-b') === 'hello from B';

a.destroy(); b.destroy(); c.destroy();
await wait(300);

console.log('\nPHASE 1 GATE:', pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
