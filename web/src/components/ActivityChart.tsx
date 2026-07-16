import { useState } from 'react';

interface Day { date: string; count: number }

/* Single-series bar chart (sessions per day). One clay hue, rounded data
   ends, 3px gaps, recessive gridlines, hover tooltip per bar. */
export function ActivityChart({ data }: { data: Day[] }) {
  const [tip, setTip] = useState<{ x: number; y: number; day: Day } | null>(null);
  const max = Math.max(1, ...data.map((d) => d.count));

  return (
    <div className="chart"
      onMouseLeave={() => setTip(null)}>
      <span className="y-max">{max}</span>
      <div className="gridline" style={{ top: 8 }} />
      <div className="gridline" style={{ top: 8 + 56 }} />
      <div className="bars" role="img"
        aria-label={`Sessions per day over the last ${data.length} days`}>
        {data.map((day) => {
          const h = day.count === 0 ? 2 : Math.max(4, Math.round((day.count / max) * 104));
          const dateLabel = new Date(`${day.date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short' });
          const showLabel = new Date(`${day.date}T00:00:00`).getDay() === 1; // Mondays
          return (
            <div key={day.date} className="bar-col"
              onMouseMove={(e) => {
                const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
                setTip({ x: e.clientX - rect.left, y: 0, day });
              }}>
              <div className={`bar${day.count === 0 ? ' zero' : ''}`} style={{ height: h }} />
              <span className="x-label">{showLabel ? dateLabel : ' '}</span>
            </div>
          );
        })}
      </div>
      {tip && (
        <div className="tip" style={{ left: tip.x, top: 2 }}>
          {new Date(`${tip.day.date}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          {' — '}{tip.day.count} session{tip.day.count === 1 ? '' : 's'}
        </div>
      )}
    </div>
  );
}
