/**
 * Open Directional Sensitivity — calibrate.html WebHID client tests. The marked block is run
 * against the OpenMouse TS client (same bytes on the cable and through the receiver), the
 * receiver's relay envelope and link check (spec/hid-protocol-v1.md §2.3) and a device that
 * never identifies itself.
 *
 * SPDX-License-Identifier: MIT
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  crc16Ccitt,
  importProfileJson,
  OpenMouseDirectionalDpiClient,
  serializeProfileV1,
} from "../../integrations/openmouse/src/directional-dpi.ts";
import { MockGloriousSeriesOneProHidDevice } from "../../integrations/openmouse/src/mock-hid.ts";

type Device = {
  vendorId: number;
  productId: number;
  productName: string;
  sendFeatureReport(reportId: number, data: Uint8Array): Promise<void>;
  receiveFeatureReport(reportId: number): Promise<DataView>;
};
type Client = { dev: Device; relay: boolean; seq: number; onWait?: () => void };
type ProfileDoc = Record<string, unknown>;

const html = readFileSync(new URL("../../web/calibrate.html", import.meta.url), "utf8");
const exportSrc = /\/\/ --- profile export[^\n]*\n([\s\S]*?)\/\/ --- end profile export ---/.exec(html)?.[1];
const clientSrc = /\/\/ --- BEGIN webhid client[^\n]*\n([\s\S]*?)\/\/ --- END webhid client ---/.exec(html)?.[1];
assert.ok(exportSrc && clientSrc, "marked blocks not found in calibrate.html");
const buildProfileJson = new Function(`${exportSrc}\nreturn buildProfileJson;`)() as (
  gainsCcw: number[],
  baseCpi: number,
  windowCounts: number,
  onlyAtBaseDpi?: boolean
) => ProfileDoc;
const page = new Function(`${clientSrc}\nreturn { encodeProfile, ddpiCommand, detectMouse, OP };`)() as {
  encodeProfile(doc: ProfileDoc): Uint8Array;
  ddpiCommand(c: Client, opcode: number, payload?: number[] | Uint8Array): Promise<Uint8Array>;
  detectMouse(dev: Device, seq?: number, onWait?: () => void): Promise<Client>;
  OP: Record<"GET_CAPABILITIES" | "SET_PROFILE" | "SAVE_FLASH" | "SET_ENABLED", number>;
};

/** Records every SET_REPORT body a device gets */
function recorded<T extends Device>(dev: T): Uint8Array[] {
  const sent: Uint8Array[] = [];
  const send = dev.sendFeatureReport.bind(dev);
  dev.sendFeatureReport = (id, data) => {
    sent.push(Uint8Array.from(data));
    return send(id, data);
  };
  return sent;
}

const isDdpi = (p: Uint8Array): boolean => p[0] === 0x44 && p[1] === 0x50 && p[5] === 0xdf;
const STOCK_VERSION = [0xa1, 0, 0, 0x03, 0, 0x81, 0x01, 0, 0, 0, 0x20, 0x18]; // fact 3 (2026-11-13)
const DP01 = [0x44, 0x50, 0x30, 0x31];
const LINK_QUERY = [0, 0, 0, 0, 0, 0x89, ...new Array<number>(58).fill(0)]; // receiver-local 0x89

/**
 * 258a:2031 as spec §2.3 describes it: forwards only body[2] = 0x02, sends and copies back
 * body[3] + 6 bytes (the rest of the reply buffer is stale), 0xA0 while pending, a transient
 * 0xA4 during SAVE_FLASH, and 0xA4 for good when the mouse is unreachable. The mouse behind it
 * restores the canonical body[0], [2], [3] before the DDPI handler checks the CRC, as the patch does.
 * The link query 0x89 answers 0xA1 and body[6] = 0x01, or 0x00 for the next `linkDown` queries.
 * Without a mouse each relayed request sets `linkDown` to 2: the receiver clears its link flag on
 * link loss before it answers 0xA4 (disassembly 0xDA86 / 0xDAB0). A real receiver would answer 0x00
 * until the mouse links again; the link coming back after 2 queries, and 0x01 before the first
 * relayed request, are test shortcuts so the off case ends after two sends. The link state during
 * the retail 0xA4 failures was not read. Only body[0..6] of the buffer change.
 */
class FakeReceiver implements Device {
  vendorId = 0x258a;
  productId = 0x2031;
  productName = "2.4G Wireless Receiver";
  private buf: Uint8Array = new Uint8Array(64);
  private pending: Uint8Array[] = []; // one per GET_REPORT, the last one stays
  private mouse: MockGloriousSeriesOneProHidDevice | null;
  stamped: boolean; // the mouse's version reply carries DP01 at 12..19
  linkDown = 0;

  constructor(mouse: MockGloriousSeriesOneProHidDevice | null, stamped = true) {
    this.mouse = mouse;
    this.stamped = stamped;
    this.buf.set(DP01, 16); // stale bytes: the relayed version query must not trust 16..19
  }

  async sendFeatureReport(_id: number, body: Uint8Array): Promise<void> {
    const wait = Uint8Array.from(this.buf);
    wait[0] = 0xa0;
    if (body[2] !== 0x02 && body[4] === 0x00 && body[5] === 0x89) {
      const link = Uint8Array.from(this.buf);
      link.set([0xa1, ...body.subarray(1, 6), this.linkDown > 0 ? 0x00 : 0x01]);
      this.linkDown = Math.max(0, this.linkDown - 1);
      this.pending = [link];
      return;
    }
    if (body[2] !== 0x02) {
      const echo = Uint8Array.from(body);
      echo[0] = 0xa3; // receiver-local: unknown command
      this.pending = [echo];
      return;
    }
    if (!this.mouse) {
      const down = Uint8Array.from(wait);
      down[0] = 0xa4;
      this.pending = [wait, down];
      this.linkDown = 2; // link loss, see above
      return;
    }
    const n = body[3]! + 6;
    const fwd = new Uint8Array(64);
    fwd.set(body.subarray(0, n));
    let reply: Uint8Array = new Uint8Array(64);
    if (fwd[1] === 0x50 && fwd[5] === 0xdf) {
      fwd[0] = 0x44;
      fwd[2] = 0x01;
      fwd[3] = 0x00;
      await this.mouse.sendFeatureReport(0, fwd);
      reply = new Uint8Array((await this.mouse.receiveFeatureReport(0)).buffer);
    } else if (fwd[4] === 0x00 && fwd[5] === 0x81) {
      reply.set(STOCK_VERSION);
      if (this.stamped) reply.set([...DP01, ...DP01], 12);
    }
    const out = Uint8Array.from(this.buf);
    out.set(reply.subarray(0, n));
    const saving = fwd[5] === 0xdf && fwd[6] === 0x04;
    const linkStall = Uint8Array.from(wait);
    linkStall[0] = 0xa4;
    this.pending = saving ? [wait, linkStall, out] : [wait, out];
  }

  async receiveFeatureReport(_id: number): Promise<DataView> {
    this.buf = this.pending.length > 1 ? this.pending.shift()! : (this.pending[0] ?? this.buf);
    return new DataView(Uint8Array.from(this.buf).buffer);
  }
}

const GAINS = [1.0, 1.05, 1.2, 0.95, 0.9, 0.85, 0.8, 1.1];

/** Bypass, send, save: the page's session, from detection on */
async function pageSession(dev: Device, doc: ProfileDoc, onWait?: () => void): Promise<Uint8Array> {
  const c = await page.detectMouse(dev, 5, onWait);
  await page.ddpiCommand(c, page.OP.SET_ENABLED, [2]);
  await page.ddpiCommand(c, page.OP.SET_PROFILE, page.encodeProfile(doc));
  return page.ddpiCommand(c, page.OP.SAVE_FLASH);
}

/** The same session through the OpenMouse TS client */
async function tsSession(dev: Device, doc: ProfileDoc): Promise<Uint8Array[]> {
  const sent = recorded(dev);
  const ts = new OpenMouseDirectionalDpiClient(dev);
  await ts.detectCapabilities();
  await ts.bypassForCalibration();
  await ts.setProfile(importProfileJson(JSON.stringify(doc)));
  await ts.saveToFlash();
  return sent;
}

test("encodeProfile matches importProfileJson + serializeProfileV1", () => {
  for (let i = 0; i < 300; i++) {
    const gains = Array.from({ length: 8 }, () => Number((0.8 + Math.random() * 0.45).toFixed(4)));
    const cpi = 50 + Math.floor(Math.random() * 65486);
    const doc = buildProfileJson(gains, cpi, Math.floor(Math.random() * 129), Math.random() < 0.5);
    assert.deepEqual(page.encodeProfile(doc), serializeProfileV1(importProfileJson(JSON.stringify(doc))));
  }
});

test("cable: the page sends exactly the TS client's bytes", async () => {
  const doc = buildProfileJson(GAINS, 1600, 16, true);
  const dev = new MockGloriousSeriesOneProHidDevice("open-directional-dpi-v1");
  const sent = recorded(dev);
  const saved = await pageSession(dev, doc);
  const ts = await tsSession(new MockGloriousSeriesOneProHidDevice("open-directional-dpi-v1"), doc);
  assert.deepEqual(sent, ts); // version query, GET_CAPABILITIES, SET_ENABLED 2, SET_PROFILE, SAVE_FLASH
  assert.deepEqual(saved.subarray(8, 36), page.encodeProfile(doc));
});

test("receiver: the TS client's bytes, relay envelope outside the CRC", async () => {
  const doc = buildProfileJson(GAINS, 800, 16);
  const rx = new FakeReceiver(new MockGloriousSeriesOneProHidDevice("open-directional-dpi-v1"));
  const sent = recorded(rx);
  const saved = await pageSession(rx, doc); // SAVE_FLASH passes a transient 0xA4
  const ts = await tsSession(new FakeReceiver(new MockGloriousSeriesOneProHidDevice("open-directional-dpi-v1")), doc);
  assert.deepEqual(sent, ts);
  assert.equal(sent.length, 10); // link query, request: version, GET_CAPABILITIES, SET_ENABLED, SET_PROFILE, SAVE_FLASH
  const requests = sent.filter((_, i) => i % 2 === 1);
  assert.deepEqual(sent.filter((_, i) => i % 2 === 0).map((p) => [...p]), new Array(5).fill(LINK_QUERY));
  assert.deepEqual([...requests[0]!.subarray(0, 6)], [0, 0, 0x02, 0x0a, 0x00, 0x81]);
  for (const p of requests.slice(1)) {
    assert.deepEqual([p[0], p[1], p[2], p[3], p[5]], [0x44, 0x50, 0x02, 0x3a, 0xdf]);
    const canonical = Uint8Array.from(p);
    canonical.set([0x01, 0x00], 2);
    assert.equal(p[62]! | (p[63]! << 8), crc16Ccitt(canonical, 62));
    assert.notEqual(p[62]! | (p[63]! << 8), crc16Ccitt(p, 62));
  }
  assert.deepEqual(saved.subarray(8, 36), page.encodeProfile(doc));
});

test("nothing but the version query before the DP01 stamp", async () => {
  const stock = new MockGloriousSeriesOneProHidDevice("stock-glorious");
  const stockSent = recorded(stock);
  await assert.rejects(page.detectMouse(stock), /No DP01 stamp/);
  assert.deepEqual(stockSent.map((p) => [...p.subarray(0, 6)]), [[0, 0, 0x00, 0x06, 0x00, 0x81]]);
  assert.equal(stock.oddPacketsReceived, 0);

  /* No stamp at 12..15 through the receiver: stock, or a build without the relay (stamp only at 16..19) */
  const rx = new FakeReceiver(new MockGloriousSeriesOneProHidDevice("open-directional-dpi-v1"), false);
  const rxSent = recorded(rx);
  await assert.rejects(page.detectMouse(rx), /through the receiver/);
  assert.equal(rxSent.length, 2); // link query, version query
  assert.ok(!rxSent.some(isDdpi));

  /* A stamped reply left in the receiver (pending frames show it) is not this mouse's answer */
  const swapped = new FakeReceiver(new MockGloriousSeriesOneProHidDevice("open-directional-dpi-v1"));
  await swapped.sendFeatureReport(0, Uint8Array.from([0, 0, 0x02, 0x0a, 0x00, 0x81]));
  await swapped.receiveFeatureReport(0);
  await swapped.receiveFeatureReport(0); // the buffer now holds DP01 at 12..19
  swapped.stamped = false; // re-paired with an unpatched mouse
  const swappedSent = recorded(swapped);
  await assert.rejects(page.detectMouse(swapped), /through the receiver/);
  assert.ok(!swappedSent.some(isDdpi));

  const other: Device = {
    vendorId: 0x1234,
    productId: 0x0001,
    productName: "Some Mouse",
    sendFeatureReport: async () => assert.fail("sent to an unidentified device"),
    receiveFeatureReport: async () => assert.fail("read from an unidentified device"),
  };
  await assert.rejects(page.detectMouse(other), /nothing was sent/);
});

test("receiver: no link at first, the page waits for the mouse once", async () => {
  const rx = new FakeReceiver(new MockGloriousSeriesOneProHidDevice("open-directional-dpi-v1"));
  rx.linkDown = 3;
  let waits = 0;
  const saved = await pageSession(rx, buildProfileJson(GAINS, 800, 16), () => waits++);
  assert.equal(waits, 1);
  assert.deepEqual([saved[3], saved[6]], [0xa1, page.OP.SAVE_FLASH]);
});

test("[OpenDDPIv1] devices skip the Glorious query; an unreachable mouse is reported", async () => {
  const tagged = new MockGloriousSeriesOneProHidDevice("open-directional-dpi-v1");
  tagged.vendorId = 0x1234;
  tagged.productName = "My Mouse [OpenDDPIv1]";
  const sent = recorded(tagged);
  const c = await page.detectMouse(tagged, 255);
  assert.equal(c.relay, false);
  assert.equal(sent.length, 1);
  assert.ok(isDdpi(sent[0]!));
  assert.equal(sent[0]![6], page.OP.GET_CAPABILITIES);
  await page.ddpiCommand(c, page.OP.SET_ENABLED, [2]);
  assert.equal(sent[1]![4], 5); // seq wraps 255 -> 5, never below 5

  /* No mouse: final 0xA4, no link for 2 queries (the page waits once), the version query once more */
  const off = new FakeReceiver(null);
  const offSent = recorded(off);
  let waits = 0;
  await assert.rejects(page.detectMouse(off, 5, () => waits++), /cannot reach the mouse/);
  assert.deepEqual(offSent.map((p) => (p[5] === 0x89 ? "link" : p[2] === 0x02 ? "relay" : "other")),
    ["link", "relay", "link", "link", "link", "relay"]);
  assert.equal(waits, 1);
});
