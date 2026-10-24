// One status vocabulary for the whole UI: every status maps to a tone (GitHub Primer
// semantic color), a label and an icon, so a state looks the same in every view.
import type { AgentStatus, CaseStatus, MergeStatus, StepStatus } from '../../src/orchestrator/events.js';

export type Tone = 'success' | 'done' | 'accent' | 'attention' | 'danger' | 'neutral';
export type IconName = 'check' | 'x' | 'dot' | 'skip' | 'circle' | 'spin' | 'alert' | 'person' | 'play' | 'sparkle';

interface Look {
  tone: Tone;
  icon: IconName;
  label: string;
}

export const AGENT: Record<AgentStatus, Look> = {
  queued: { tone: 'neutral', icon: 'circle', label: 'Queued' },
  running: { tone: 'accent', icon: 'spin', label: 'Running' },
  passed: { tone: 'success', icon: 'check', label: 'Passed' },
  fixed: { tone: 'done', icon: 'check', label: 'Fixed' },
  proposed: { tone: 'accent', icon: 'dot', label: 'Proposed' },
  unfixable: { tone: 'danger', icon: 'alert', label: 'Needs human' },
  error: { tone: 'danger', icon: 'x', label: 'Error' },
  skipped: { tone: 'neutral', icon: 'skip', label: 'Skipped' },
};

export const STEP: Record<StepStatus, Look> = {
  waiting: { tone: 'neutral', icon: 'circle', label: 'Waiting' },
  running: { tone: 'accent', icon: 'spin', label: 'Running' },
  done: { tone: 'success', icon: 'check', label: 'Done' },
  skipped: { tone: 'neutral', icon: 'skip', label: 'Skipped' },
  failed: { tone: 'danger', icon: 'x', label: 'Failed' },
};

export const CASE: Record<CaseStatus, Look> = {
  waiting: { tone: 'neutral', icon: 'circle', label: 'Waiting' },
  pass: { tone: 'success', icon: 'check', label: 'Pass' },
  fail: { tone: 'attention', icon: 'x', label: 'Fail' },
  fixed: { tone: 'done', icon: 'check', label: 'Fixed' },
  proposed: { tone: 'accent', icon: 'dot', label: 'Proposed' },
  blocker: { tone: 'danger', icon: 'alert', label: 'Blocker' },
};

export const MERGE: Record<MergeStatus, Look> = {
  applied: { tone: 'done', icon: 'check', label: 'Applied' },
  unchanged: { tone: 'success', icon: 'check', label: 'Unchanged' },
  conflict: { tone: 'danger', icon: 'alert', label: 'Conflict' },
  error: { tone: 'danger', icon: 'x', label: 'Error' },
};

/** Small stroke icons in the spirit of GitHub's Octicons (16px grid). */
export function Icon({ name, size = 16, className = '' }: { name: IconName; size?: number; className?: string }) {
  const common = { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true, className: `icon ${className}` };
  switch (name) {
    case 'check':
      return <svg {...common}><circle cx="8" cy="8" r="6.5" /><path d="M5.2 8.2l1.9 1.9 3.7-3.9" /></svg>;
    case 'x':
      return <svg {...common}><circle cx="8" cy="8" r="6.5" /><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" /></svg>;
    case 'dot':
      return <svg {...common}><circle cx="8" cy="8" r="6.5" /><circle cx="8" cy="8" r="2.4" fill="currentColor" stroke="none" /></svg>;
    case 'skip':
      return <svg {...common}><circle cx="8" cy="8" r="6.5" /><path d="M4 12L12 4" /></svg>;
    case 'circle':
      return <svg {...common} strokeDasharray="2.6 2.4"><circle cx="8" cy="8" r="6.5" /></svg>;
    case 'spin':
      return <svg {...common} className={`icon spin ${className}`}><circle cx="8" cy="8" r="6.5" opacity="0.25" /><path d="M8 1.5a6.5 6.5 0 0 1 6.5 6.5" /></svg>;
    case 'alert':
      return <svg {...common}><path d="M8 1.8L14.6 13.6H1.4z" /><path d="M8 6.3v3.2M8 11.6v.1" /></svg>;
    case 'person':
      return <svg {...common}><circle cx="8" cy="5.2" r="2.7" /><path d="M2.8 14c.5-2.8 2.6-4.3 5.2-4.3s4.7 1.5 5.2 4.3" /></svg>;
    case 'play':
      return <svg {...common}><circle cx="8" cy="8" r="6.5" /><path d="M6.6 5.4l4 2.6-4 2.6z" fill="currentColor" /></svg>;
    case 'sparkle':
      return <svg {...common}><path d="M8 1.5l1.5 4.9 4.9 1.6-4.9 1.6L8 14.5l-1.5-4.9L1.6 8l4.9-1.6z" /></svg>;
  }
}

export function StatusIcon({ look, size }: { look: Look; size?: number }) {
  return (
    <span className={`fg-${look.tone}`} title={look.label}>
      <Icon name={look.icon} size={size} />
    </span>
  );
}

/** GitHub-style state label: tinted background, colored text and border. */
export function StateLabel({ look, small }: { look: Look; small?: boolean }) {
  return (
    <span className={`state tone-${look.tone} ${small ? 'state-sm' : ''}`}>
      <Icon name={look.icon} size={small ? 12 : 14} />
      {look.label}
    </span>
  );
}

export const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
export const fmtTime = (ms: number) =>
  ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`;
export const fmtClock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
