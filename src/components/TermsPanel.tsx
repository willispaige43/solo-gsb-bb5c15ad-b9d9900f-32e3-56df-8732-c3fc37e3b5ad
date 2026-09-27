import { useMemo, useState } from 'react';
import type { Cue } from '../lib/types';
import { planTermReplace, type TermRule } from '../lib/terms';
import { formatTimecode, uid } from '../lib/time';

interface Props {
  /** 当前字幕（已按 start 排序）；仅未锁定片段参与替换，规划本身不改数据 */
  cues: Cue[];
  /** 确认应用：仅把命中片段的正文替换为预览文本，其余字段由调用方保留 */
  onApply: (entries: { id: string; text: string }[], totalHits: number) => void;
  onJump: (id: string) => void;
}

/**
 * 术语统一面板：
 * 输入多组“原词 → 替换词”，对当前未锁定字幕的正文生成批量替换预览。
 * 匹配以可见文字为准：原词可跨越 WebVTT 内联格式标签（<b>、<v …> 等），
 * 时间戳标签（<00:01.500>）是匹配边界；替换时所有标签的原文与顺序、
 * 标签外未命中的文字均原样保留。同一位置多条规则命中时取最长原词，
 * 等长按输入顺序；基于原文一次匹配，替换结果不再参与匹配。
 * 预览逐条显示命中次数与替换后的正文；确认后仅写入命中的未锁定片段，
 * 时间码、标识符、cue 设置与锁定状态不变。
 */
export default function TermsPanel({ cues, onApply, onJump }: Props) {
  const [open, setOpen] = useState(false);
  const [rules, setRules] = useState<TermRule[]>([{ id: uid(), from: '', to: '' }]);

  const unlockedCount = useMemo(() => cues.filter((c) => !c.locked).length, [cues]);
  const plan = useMemo(() => planTermReplace(cues, rules), [cues, rules]);
  const cueById = useMemo(() => new Map(cues.map((c) => [c.id, c])), [cues]);
  // 有效规则（原词非空）在 plan.rules 中的下标，按规则 id 对齐，逐条显示命中次数
  const validIndexById = useMemo(() => {
    const m = new Map<string, number>();
    let k = 0;
    for (const r of rules) {
      if (r.from.length > 0) {
        m.set(r.id, k);
        k++;
      }
    }
    return m;
  }, [rules]);

  function patchRule(id: string, patch: Partial<TermRule>) {
    setRules((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function removeRule(id: string) {
    setRules((rs) => rs.filter((r) => r.id !== id));
  }

  function addRule() {
    setRules((rs) => [...rs, { id: uid(), from: '', to: '' }]);
  }

  function confirm() {
    if (plan.entries.length === 0) return;
    onApply(plan.entries.map((e) => ({ id: e.id, text: e.replaced })), plan.totalHits);
    setOpen(false);
  }

  if (!open) {
    return (
      <section className="panel terms-panel">
        <h2>
          术语统一
          <span className="muted small ml">未锁定片段批量替换</span>
        </h2>
        <p className="muted small">
          输入多组「原词 → 替换词」，按可见文字批量替换未锁定片段的正文：原词可跨越内联格式标签，
          时间戳标签为匹配边界；所有标签与未命中文字原样保留。确认前逐条预览命中次数与替换结果。
        </p>
        <button className="btn primary" disabled={unlockedCount === 0} onClick={() => setOpen(true)}>
          设置术语规则并预览
        </button>
        {unlockedCount === 0 && (
          <p className="muted small">当前没有未锁定片段（锁定片段不参与替换）。</p>
        )}
      </section>
    );
  }

  return (
    <section className="panel terms-panel">
      <h2>
        术语统一
        <span className="muted small ml">
          有效规则 {plan.rules.length} 条 · 命中 {plan.entries.length} 条
        </span>
      </h2>
      <p className="muted small">
        同一位置多条规则命中时取<strong>最长原词</strong>，等长按输入顺序；基于原文一次匹配，
        替换结果不再参与匹配。原词为空的规则不参与替换。
      </p>

      <div className="term-rules">
        <div className="term-rule-row term-rule-head">
          <span>原词</span>
          <span />
          <span>替换为</span>
          <span />
        </div>
        {rules.map((rule, i) => {
          const statIdx = validIndexById.get(rule.id);
          const stat = statIdx !== undefined ? plan.rules[statIdx] : undefined;
          return (
            <div className="term-rule-row" key={rule.id}>
              <input
                className={`term-input mono${rule.from ? '' : ' empty'}`}
                value={rule.from}
                placeholder="原词（必填）"
                onChange={(e) => patchRule(rule.id, { from: e.target.value })}
              />
              <span className="term-arrow">→</span>
              <input
                className="term-input mono"
                value={rule.to}
                placeholder="替换词（可留空）"
                onChange={(e) => patchRule(rule.id, { to: e.target.value })}
              />
              <span className="term-rule-side">
                {stat && (
                  <span className={`term-hits${stat.hits > 0 ? ' on' : ''}`} title="该规则在全部未锁定片段中的命中次数">
                    ×{stat.hits}
                  </span>
                )}
                <button
                  className="mini danger"
                  title="删除该规则"
                  onClick={() => removeRule(rule.id)}
                  disabled={rules.length === 1 && i === 0}
                >
                  ✕
                </button>
              </span>
            </div>
          );
        })}
      </div>
      <div className="merge-actions">
        <button className="btn" onClick={addRule}>＋ 添加规则</button>
        {rules.some((r) => !r.from) && (
          <span className="muted small">存在原词为空的规则，已忽略。</span>
        )}
      </div>

      <div className="merge-summary">
        命中 <strong>{plan.entries.length}</strong> 个片段 · 共 {plan.totalHits} 处替换 ·
        未命中 {plan.scanned - plan.entries.length} 条 · 锁定跳过 {plan.lockedSkipped} 条
      </div>

      {plan.rules.length === 0 && (
        <div className="import-error">请至少填写一条原词非空的规则。</div>
      )}

      {plan.rules.length > 0 && plan.entries.length === 0 && (
        <div className="import-error">
          当前规则在未锁定片段的正文中没有命中（锁定片段不参与替换），无法应用。
        </div>
      )}

      {plan.entries.length > 0 && (
        <>
          <div className="merge-section-label">替换预览（{plan.entries.length} 条）</div>
          <ul className="merge-list term-list">
            {plan.entries.map((entry, i) => {
              const cue = cueById.get(entry.id);
              return (
                <li
                  key={entry.id}
                  className="merge-row term-row"
                  onClick={() => onJump(entry.id)}
                  title="点击定位到该片段"
                >
                  <div className="merge-head mono">
                    <span className="merge-idx">#{i + 1}</span>
                    {cue && (
                      <span>
                        {formatTimecode(cue.start)} – {formatTimecode(cue.end)}
                      </span>
                    )}
                    <span className="term-hits on">命中 ×{entry.hits}</span>
                  </div>
                  <div className="wrap-text orig">
                    <span className="wrap-label">原文</span>
                    {entry.original}
                  </div>
                  <div className="wrap-text suggested">
                    <span className="wrap-label">替换</span>
                    {entry.replaced}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <div className="merge-actions end">
        <button className="btn" onClick={() => setOpen(false)}>取消</button>
        <button className="btn primary" disabled={plan.entries.length === 0} onClick={confirm}>
          确认应用（{plan.entries.length} 条）
        </button>
      </div>
    </section>
  );
}
