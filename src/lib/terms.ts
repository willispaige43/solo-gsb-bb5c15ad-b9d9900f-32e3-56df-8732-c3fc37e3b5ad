import type { Cue } from './types';
import { parseTimecode } from './time';

/**
 * 术语统一：对未锁定 cue 的正文做批量“原词 → 替换词”替换。
 *
 * 匹配语义：
 * - 以可见文字为准：WebVTT 内联格式标签（<b>、</b>、<v …> 等）不参与匹配，
 *   原词可以跨越这些标签（标签对匹配透明）；
 * - 时间戳标签（<00:01.500>）是匹配边界：其内部文字不可见，且匹配不得跨越它；
 * - 不完整的 “<”（同行内没有匹配的 “>”）按普通文字处理。
 *
 * 替换语义：
 * - 所有标签（内联标签与时间戳标签）的原文、顺序原样保留，标签外未命中的
 *   文字也原样保留；命中区间内的可见文字整体替换为替换词（替换词插入在
 *   命中区间的第一个可见字符处，区间内部的标签保持原位）；
 * - 基于原文一次匹配：从左到右扫描，同一位置多条规则命中时取最长原词，
 *   等长按输入顺序取先者；替换结果不再参与匹配（不级联）。
 */

export interface TermRule {
  id: string;
  /** 原词（按可见文字精确匹配，区分大小写与空白；空原词的规则不参与） */
  from: string;
  /** 替换词（可为空，表示删除命中的原词） */
  to: string;
}

type TermTokenKind = 'text' | 'tag' | 'boundary';

interface TermToken {
  /** 原始文本片段（输出时原样保留） */
  raw: string;
  kind: TermTokenKind;
}

/**
 * 切分 cue 正文：时间戳标签为 boundary（匹配边界），其它 <…> 为 tag
 * （对匹配透明、原样保留），其余为 text（可见文字，逐码点参与匹配）。
 */
function tokenize(text: string): TermToken[] {
  const tokens: TermToken[] = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      tokens.push({ raw: buf, kind: 'text' });
      buf = '';
    }
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '<') {
      const end = text.indexOf('>', i + 1);
      const nl = text.indexOf('\n', i + 1);
      if (end !== -1 && (nl === -1 || end < nl) && !text.slice(i + 1, end).includes('<')) {
        flush();
        const inner = text.slice(i + 1, end);
        tokens.push({
          raw: text.slice(i, end + 1),
          kind: parseTimecode(inner) !== null ? 'boundary' : 'tag',
        });
        i = end + 1;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return tokens;
}

interface IndexedRule {
  from: string;
  to: string;
  /** 规则在调用方规则数组中的下标（用于逐规则计数） */
  ruleIndex: number;
}

interface TermMatch {
  /** 命中区间在可见文字中的起止（码元下标，左闭右开） */
  start: number;
  end: number;
  to: string;
  /** 命中规则在调用方规则数组中的下标 */
  ruleIndex: number;
}

/**
 * 在一段可见文字上做一次扫描匹配（不修改输入）：
 * 每个位置取能命中的最长原词，等长按规则输入顺序；命中后跳过整段原词，
 * 替换结果不再参与匹配。返回按起点升序、互不重叠的命中列表。
 */
function findMatches(visible: string, rules: IndexedRule[]): TermMatch[] {
  // 按首码元分桶，桶内按“最长优先、等长先输入优先”排序，扫描时取首个命中者
  const buckets = new Map<string, IndexedRule[]>();
  for (const r of rules) {
    if (r.from.length === 0) continue;
    const first = r.from[0];
    const arr = buckets.get(first) ?? [];
    arr.push(r);
    buckets.set(first, arr);
  }
  for (const arr of buckets.values()) {
    arr.sort((a, b) => b.from.length - a.from.length || a.ruleIndex - b.ruleIndex);
  }

  const matches: TermMatch[] = [];
  let i = 0;
  while (i < visible.length) {
    const bucket = buckets.get(visible[i]);
    let chosen: IndexedRule | null = null;
    if (bucket) {
      for (const cand of bucket) {
        if (visible.startsWith(cand.from, i)) {
          chosen = cand;
          break;
        }
      }
    }
    if (chosen) {
      matches.push({ start: i, end: i + chosen.from.length, to: chosen.to, ruleIndex: chosen.ruleIndex });
      i += chosen.from.length;
    } else {
      i += 1;
    }
  }
  return matches;
}

export interface TermReplaceResult {
  /** 替换后的正文（无命中时与输入相同） */
  text: string;
  /** 命中次数（替换处数） */
  hits: number;
  /** 逐规则命中次数，与传入规则数组等长对齐 */
  perRule: number[];
}

/**
 * 对单条 cue 正文执行术语替换（不修改输入）。
 * 所有标签原文与顺序、标签外未命中文字原样保留；时间戳标签为匹配边界。
 */
export function replaceTerms(text: string, rules: { from: string; to: string }[]): TermReplaceResult {
  const perRule = rules.map(() => 0);
  const active: IndexedRule[] = rules
    .map((r, ruleIndex) => ({ from: r.from, to: r.to, ruleIndex }))
    .filter((r) => r.from.length > 0);
  if (active.length === 0) return { text, hits: 0, perRule };

  const tokens = tokenize(text);
  let out = '';
  let hits = 0;

  // 按时间戳标签切分为若干可见段，逐段匹配与重建，边界标签原样写回
  let segment: TermToken[] = [];
  const flushSegment = () => {
    if (segment.length === 0) return;
    // 可见文字仅来自文本 token；内联标签对匹配透明（不占可见下标）
    const visible = segment
      .filter((t) => t.kind === 'text')
      .map((t) => t.raw)
      .join('');
    const matches = findMatches(visible, active);
    if (matches.length === 0) {
      for (const t of segment) out += t.raw; // 无命中：整段（含标签）原样写回
      segment = [];
      return;
    }
    let mi = 0;
    let skipUntil = -1; // 处于命中区间内的可见下标上界（左闭右开）
    let vis = 0;
    for (const tok of segment) {
      if (tok.kind === 'tag') {
        out += tok.raw; // 内联标签原样保留在原位
        continue;
      }
      // 可见下标按 UTF-16 码元计，与 startsWith / from.length 口径一致
      for (let k = 0; k < tok.raw.length; k++) {
        if (mi < matches.length && vis === matches[mi].start) {
          out += matches[mi].to;
          skipUntil = matches[mi].end;
          perRule[matches[mi].ruleIndex]++;
          hits++;
          mi++;
        }
        if (vis < skipUntil) {
          vis++; // 命中区间内的可见字符：丢弃（已被替换词取代）
          continue;
        }
        out += tok.raw[k];
        vis++;
      }
    }
    segment = [];
  };

  for (const tok of tokens) {
    if (tok.kind === 'boundary') {
      flushSegment();
      out += tok.raw; // 时间戳标签原样保留
    } else {
      segment.push(tok);
    }
  }
  flushSegment();

  return { text: out, hits, perRule };
}

/** 单个命中 cue 的预览条目 */
export interface TermHitEntry {
  id: string;
  /** 该 cue 内的命中次数 */
  hits: number;
  /** 原文（当前 cue 正文） */
  original: string;
  /** 替换后的正文 */
  replaced: string;
}

export interface TermPlan {
  /** 有效规则（原词非空），按输入顺序，附各自命中次数 */
  rules: { from: string; to: string; hits: number }[];
  /** 有命中的未锁定 cue（保持传入顺序） */
  entries: TermHitEntry[];
  /** 全部命中次数（替换处数） */
  totalHits: number;
  /** 参与扫描的未锁定 cue 数 */
  scanned: number;
  /** 跳过的锁定 cue 数 */
  lockedSkipped: number;
}

/**
 * 批量规划：仅扫描未锁定 cue，不修改输入。
 * 确认应用时只需把 entries 中各 id 的正文替换为 replaced。
 */
export function planTermReplace(cues: Cue[], rules: TermRule[]): TermPlan {
  const valid = rules.filter((r) => r.from.length > 0);
  const plan: TermPlan = {
    rules: [],
    entries: [],
    totalHits: 0,
    scanned: 0,
    lockedSkipped: 0,
  };
  const perRuleTotal = valid.map(() => 0);

  for (const cue of cues) {
    if (cue.locked) {
      plan.lockedSkipped++;
      continue;
    }
    plan.scanned++;
    if (valid.length === 0) continue;
    const r = replaceTerms(cue.text, valid);
    if (r.hits > 0) {
      plan.entries.push({ id: cue.id, hits: r.hits, original: cue.text, replaced: r.text });
      plan.totalHits += r.hits;
      for (let i = 0; i < valid.length; i++) perRuleTotal[i] += r.perRule[i];
    }
  }

  plan.rules = valid.map((r, i) => ({ from: r.from, to: r.to, hits: perRuleTotal[i] }));
  return plan;
}
