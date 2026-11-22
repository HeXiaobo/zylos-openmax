import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME;

/** The existing Dashboard component config is the shared local address source. */
export function getDashboardPort({ home = HOME, zylosDir = path.join(home, 'zylos') } = {}) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(zylosDir, 'components/dashboard/config.json'), 'utf8'));
    return config.port || 3470;
  } catch {
    return 3470;
  }
}
