#!/usr/bin/env node
/**
 * 镜像层回归：issue #2 的「无限重写同一批事件」。
 *
 *   node test/mirror.mjs
 *
 * 根因（1.5.2 及更早）：
 *   backfill() 里 `pushEvent(id, events.slice(have))` 把**一批**当成**一条**塞进
 *   缓冲区。commit() 于是 `slot.events += 1`（而不是 += 5000）、
 *   `Math.max(...events.map(e => e.seq))` 拿到的是数组的 .seq（undefined → 0）。
 *   结果索引里 events / lastSeq 永远推进不了，下一次 backfill 又算出同一段缺口，
 *   同一批事件被反复追加 —— 实测 0.83 MB/s，单会话 256 MB。
 *
 * 这个测试就是钉住这件事：重复补录，磁盘一个字节都不能再长。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { createMirror } from "../lib/mirror.js";

let failures = 0;
function ok(name, detail) {
  console.log(`  ok   ${name}${detail ? `  ${detail}` : ""}`);
}
function bad(name, detail) {
  failures += 1;
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
}
function eq(name, actual, expected) {
  if (actual === expected) ok(name, `= ${actual}`);
  else bad(name, `期望 ${expected}，实际 ${actual}`);
}

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pf-mirror-"));
}

function writeSession(home, sid, count, seqFrom = 0) {
  const dir = path.join(home, "sessions", "b1", sid);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  for (let i = 0; i < count; i += 1) {
    lines.push(
      JSON.stringify({
        seq: seqFrom + i,
        type: "user/message",
        data: { content: `事件 ${seqFrom + i}`, source: { kind: "user" } },
      }),
    );
  }
  const buf = zlib.zstdCompressSync(Buffer.from(`${lines.join("\n")}\n`, "utf8"));
  fs.writeFileSync(path.join(dir, "session.v4.jsonl.zstd"), buf);
}

function dirBytes(dir) {
  let total = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return total;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirBytes(p);
    else {
      try {
        total += fs.statSync(p).size;
      } catch {
        /* ignore */
      }
    }
  }
  return total;
}

const CFG = { mirrorDir: "raw", shadowSnapshot: true, rawStream: false, retractProbe: false };

console.log("1. 重复补录不再重写同一批事件");

{
  const home = tmpHome();
  writeSession(home, "sid-big", 5000);
  writeSession(home, "sid-small", 20);
  const mirror = createMirror(CFG, home);

  const first = mirror.backfill(true);
  eq("首轮补录条数", first, 5020);
  const after = dirBytes(path.join(home, "raw"));
  for (let i = 0; i < 6; i += 1) {
    mirror.flush();
    mirror.backfill(true);
  }
  const grown = dirBytes(path.join(home, "raw")) - after;
  if (grown === 0) ok("6 轮 commit+backfill 后零增长");
  else bad("镜像还在长", `多写了 ${grown} 字节`);

  const idx = JSON.parse(fs.readFileSync(path.join(home, "raw", "index.json"), "utf8"));
  eq("index.events 等于源事件数", idx["sid-big"]?.events, 5000);
  eq("index.lastSeq 等于最大 seq", idx["sid-big"]?.lastSeq, 4999);
  const srcSize = fs.statSync(path.join(home, "sessions", "b1", "sid-big", "session.v4.jsonl.zstd")).size;
  const mirSize = fs.statSync(path.join(home, "raw", "sid-big", "events.jsonl.zstd")).size;
  if (mirSize < srcSize * 2) ok("镜像文件没有膨胀", `${mirSize} B ≤ 2×${srcSize} B`);
  else bad("镜像文件膨胀", `${mirSize} B vs 源 ${srcSize} B`);

  mirror.dispose();
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("\n2. 源日志继续增长时，只补增量");

{
  const home = tmpHome();
  writeSession(home, "sid-live", 100);
  const mirror = createMirror(CFG, home);
  mirror.backfill(true);
  mirror.flush();
  const before = dirBytes(path.join(home, "raw"));

  // 追加到 300 条：重写整份日志，模拟宿主继续往后写。
  writeSession(home, "sid-live", 300);
  const added = mirror.backfill(true);
  mirror.flush();
  eq("增量补录条数", added, 200);
  const idx = JSON.parse(fs.readFileSync(path.join(home, "raw", "index.json"), "utf8"));
  eq("总条数", idx["sid-live"]?.events, 300);
  if (dirBytes(path.join(home, "raw")) > before) ok("有增长，且只增长一次");
  else bad("没有增长", "增量补录应该写东西");

  // 再补一轮：必须零增长。
  const mid = dirBytes(path.join(home, "raw"));
  mirror.flush();
  mirror.backfill(true);
  eq("再补一轮的增长", dirBytes(path.join(home, "raw")) - mid, 0);

  mirror.dispose();
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("\n3. 旧版本写坏的帧（一批一行）仍能读回来");

{
  const home = tmpHome();
  const dir = path.join(home, "raw", "sid-old");
  fs.mkdirSync(dir, { recursive: true });
  // 模拟 1.5.2 的产物：整批事件被 JSON.stringify 成一个数组，占一行。
  const batch = [
    { seq: 1, type: "user/message", data: { content: "第一句" } },
    { seq: 2, type: "assistant/message", data: { message: { content: [{ type: "text", text: "第二句" }] } } },
  ];
  const frame = zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(batch)}\n`, "utf8"));
  fs.writeFileSync(path.join(dir, "events.jsonl.zstd"), frame);
  fs.writeFileSync(
    path.join(home, "raw", "index.json"),
    JSON.stringify({ "sid-old": { events: 1, lastSeq: 0, firstSeen: Date.now(), lastSeen: Date.now() } }),
  );

  const mirror = createMirror(CFG, home);
  const md = mirror.recover("sid-old");
  if (md.includes("第一句") && md.includes("第二句")) ok("recover 摊平了旧帧");
  else bad("recover 读不出旧帧内容", md.slice(0, 160));

  const v = mirror.verify("sid-old");
  eq("verify 数出真实事件数", v.events, 2);
  mirror.dispose();
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("\n4. 单会话字节上限，到顶就停");

{
  const home = tmpHome();
  const mirror = createMirror({ ...CFG, mirrorMaxMb: 0.004 }, home);
  const file = path.join(home, "raw", "sid-cap", "events.jsonl.zstd");
  const sizeNow = () => {
    try {
      return fs.statSync(file).size;
    } catch {
      return 0;
    }
  };
  let seq = 0;
  for (let i = 0; i < 40; i += 1) {
    const batch = [];
    for (let k = 0; k < 50; k += 1) {
      seq += 1;
      batch.push({ seq, type: "user/message", data: { content: `填充内容 ${seq} 用来把帧撑大一点` } });
    }
    mirror.pushEvents("sid-cap", batch);
    mirror.flush();
  }
  const size = sizeNow();
  const cap = 0.004 * 1024 * 1024;
  if (size > 0 && size <= cap + 4096) ok("停在上限附近", `${size} B / 上限 ${Math.round(cap)} B`);
  else bad("超出上限", `${size} B / 上限 ${Math.round(cap)} B`);

  // 继续塞：不许再长。
  for (let i = 0; i < 5; i += 1) {
    mirror.pushEvents("sid-cap", [{ seq: 9000 + i, type: "user/message", data: { content: "溢出" } }]);
    mirror.flush();
  }
  eq("后续批次不再写", sizeNow(), size);

  mirror.dispose();
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("\n5. 索引写不进去时，不进入重放循环");

{
  const home = tmpHome();
  writeSession(home, "sid-ro", 2000);
  const mirror = createMirror(CFG, home);
  mirror.backfill(true);
  mirror.flush();

  // 把 index.json 换成目录：rename 必失败，模拟只读/占位冲突。
  const idxFile = path.join(home, "raw", "index.json");
  fs.rmSync(idxFile, { force: true });
  fs.mkdirSync(idxFile);

  const errs = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  mirror.backfill(true);
  mirror.flush();
  const size = fs.statSync(path.join(home, "raw", "sid-ro", "events.jsonl.zstd")).size;
  for (let i = 0; i < 4; i += 1) {
    mirror.flush();
    mirror.backfill(true);
  }
  const after = fs.statSync(path.join(home, "raw", "sid-ro", "events.jsonl.zstd")).size;
  void origWrite;
  void errs;
  eq("索引坏掉后不再追加", after, size);

  mirror.dispose();
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("\n6. 同一批被塞两次也只写一次（seq 去重）");

{
  const home = tmpHome();
  const mirror = createMirror(CFG, home);
  const batch = [
    { seq: 1, type: "user/message", data: { content: "a" } },
    { seq: 2, type: "user/message", data: { content: "b" } },
  ];
  const took1 = mirror.pushEvents("sid-dup", batch);
  const took2 = mirror.pushEvents("sid-dup", batch);
  eq("第一次收下", took1, 2);
  eq("第二次全被去重", took2, 0);
  mirror.flush();
  const idx = JSON.parse(fs.readFileSync(path.join(home, "raw", "index.json"), "utf8"));
  eq("落盘条数", idx["sid-dup"]?.events, 2);
  mirror.dispose();
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "镜像回归通过" : "镜像回归有失败"}：${failures} 处失败`);
process.exit(failures === 0 ? 0 : 1);
