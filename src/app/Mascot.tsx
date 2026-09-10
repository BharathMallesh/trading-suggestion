// Luna mascot: a spiky yellow burst with two angular eyes. Pure SVG so it
// scales crisply and needs no assets (stays offline-friendly).
import { theme } from './theme';

export function Mascot({ size = 320, expression = 'default' }: { size?: number; expression?: 'default' | 'calm' }) {
  const eyeTilt = expression === 'calm' ? 4 : 14;
  return (
    <svg width={size} height={size} viewBox="0 0 200 200" role="img" aria-label="Luna">
      <path
        fill={theme.color.accent}
        d="M100 4l16 46 40-30-14 48 50-6-40 30 44 24-50 4 24 44-42-26-6 50-22-44-40 30 14-48-50 6 40-30L4 100l50-4-24-44 42 26 6-50 22 44 40-30-14 48z"
      />
      {/* eyes: angular almond shapes tilted inward */}
      <g transform="translate(72 96)">
        <polygon points="0,8 34,-2 30,16" fill="#fafafa" transform={`rotate(${eyeTilt} 17 7)`} />
        <circle cx="20" cy="10" r="7" fill="#111" />
      </g>
      <g transform="translate(96 96)">
        <polygon points="34,8 0,-2 4,16" fill="#fafafa" transform={`rotate(${-eyeTilt} 17 7)`} />
        <circle cx="14" cy="10" r="7" fill="#111" />
      </g>
    </svg>
  );
}
