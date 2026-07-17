# Skill: anomaly

Method for judging whether a metric movement is a real anomaly.

- Build the baseline from at least 28 days at the asset's natural grain and
  compare like-for-like: weekday vs same weekday, month-end vs month-end.
- Use robust statistics (median absolute deviation) over plain z-scores when
  the series has outliers; flag |z| >= 3 as candidate anomalies.
- A candidate is only reportable when it is (a) sustained beyond a single
  point or (b) extreme enough that one point matters, and (c) attributable:
  drill one dimension down and name the driver segment, or explicitly state
  "driver unknown".
- Known benign patterns to rule out first: backfills (sudden historical
  rewrites), late-arriving data (partial current day), release-day resets,
  and holiday seasonality.
- Include the exact SQL used for every number you cite.
