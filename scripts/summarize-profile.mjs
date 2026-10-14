// SPDX-License-Identifier: GPL-3.0+
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
const directory = process.argv[2];
if (!directory) throw new Error('Pass a performance artifact directory');
for (const filename of (await readdir(directory)).filter(f => f.endsWith('.cpuprofile')).sort()) {
  const profile = JSON.parse(await readFile(path.join(directory, filename), 'utf8'));
  const nodes = new Map(profile.nodes.map(n => [n.id, n]));
  const times = new Map();
  profile.samples?.forEach((id, i) => {
    const name = nodes.get(id).callFrame.functionName;
    times.set(name, (times.get(name) || 0) + profile.timeDeltas[i]);
  });
  console.log(filename);
  for (const [name, time] of [...times].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`${(time / 1e6).toFixed(2)} s ${name}`);
}
const report = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8'));
const window = report.samples.filter(s => s.visible > 1000 && s.metrics?.[0] >= 18 && s.metrics[0] <= 20);
const first = window[0], last = window.at(-1);
console.log(JSON.stringify({ firstVisibleSeconds: report.firstVisibleSeconds, comparisonWindow: '18–20 guest seconds, publisher intro', samples: window.length, guestSpeed: first && last ? (last.metrics[0] - first.metrics[0]) / (last.wallSeconds - first.wallSeconds) : null, guestVsyncFPS: first && last ? (last.metrics[1] - first.metrics[1]) / (last.wallSeconds - first.wallSeconds) : null, medianInternalFPS: window.length ? window.map(s => s.metrics[3]).sort((a,b) => a-b)[Math.floor(window.length/2)] : null }, null, 2));
