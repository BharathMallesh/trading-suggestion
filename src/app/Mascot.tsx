// Buddy mascot: a friendly rounded sun-burst with happy round eyes and a smile.
// Pure SVG so it scales crisply and needs no assets (stays offline-friendly).
import { theme } from './theme';

export function Mascot({ size = 320, expression = 'default' }: { size?: number; expression?: 'default' | 'calm' }) {
  const c = theme.color.accent;
  const ink = theme.color.accentText;
  const rays = Array.from({ length: 12 });
  return (
    <svg width={size} height={size} viewBox="0 0 200 200" role="img" aria-label="Buddy">
      {/* soft rounded rays */}
      {rays.map((_, i) => {
        const a = (i / rays.length) * Math.PI * 2;
        return (
          <line
            key={i}
            x1={100 + Math.cos(a) * 58}
            y1={100 + Math.sin(a) * 58}
            x2={100 + Math.cos(a) * 88}
            y2={100 + Math.sin(a) * 88}
            stroke={c}
            strokeWidth={13}
            strokeLinecap="round"
          />
        );
      })}
      {/* round body */}
      <circle cx={100} cy={100} r={62} fill={c} />
      {/* happy eyes with highlights */}
      <g>
        <circle cx={82} cy={94} r={12} fill="#fafafa" />
        <circle cx={84} cy={96} r={6} fill="#1a1512" />
        <circle cx={80} cy={91} r={2.4} fill="#fafafa" />
        <circle cx={118} cy={94} r={12} fill="#fafafa" />
        <circle cx={120} cy={96} r={6} fill="#1a1512" />
        <circle cx={116} cy={91} r={2.4} fill="#fafafa" />
      </g>
      {/* friendly smile */}
      <path
        d={expression === 'calm' ? 'M80 120 Q100 132 120 120' : 'M78 118 Q100 142 122 118'}
        stroke={ink}
        strokeWidth={5}
        strokeLinecap="round"
        fill="none"
      />
      {/* little cheeks */}
      <circle cx={70} cy={114} r={5} fill={ink} opacity={0.18} />
      <circle cx={130} cy={114} r={5} fill={ink} opacity={0.18} />
    </svg>
  );
}
