import fs from 'fs';
import { exec } from 'child_process';
import si from 'systeminformation';
import config from './config';

const { get_paths } = config;

const PATHS = get_paths(config);

export function get_disk_space () {
  clearTimeout(global.disk_space_timeout);
  return new Promise((resolve, reject) => {
    exec('df -h', (err, stdout, stderr) => {
      if (err) {
        reject(err);
      } else {
        let rows = stdout.split(/\n+/).map((row) => row.split(/\s+/));
        rows = rows
          .splice(1)
          .map((row) => {
            const obj = {};
            rows[0].forEach((value, idx) => {
              obj[value.toLowerCase().replace(/[^A-Za-z0-9]+/i, '')] = row[idx];
            });
            return obj;
          })
          .filter(
            (obj) =>
              PATHS.findIndex((path) => {
                if (obj.mounted) {
                  return path.indexOf(obj.mounted) > -1;
                }
                return false;
              }) > -1
          )
          .map((obj) => {
            obj.percent_used = parseInt(obj.use.replace('%', ''), 10);
            obj.above_threshold = obj.percent_used > 85;
            return obj;
          });
        fs.writeFileSync('/usr/app/output/disk.json', JSON.stringify(rows));
        global.disk_space_timeout = setTimeout(() => {
          get_disk_space();
        }, 10 * 1000);
        resolve(rows);
      }
    });
  });
}

export async function get_utilization () {
  clearTimeout(global.utilization_timeout);

  const [mem, cpu] = await Promise.all([si.mem(), si.currentLoad()]);

  console.log('Memory:', mem);

  const data = {
    memory: Math.round(mem.used / mem.total * 100),
    cpu: Math.round(cpu.currentLoad),
    last_updated: new Date()
  };

  fs.writeFileSync('/usr/app/output/utilization.json', JSON.stringify(data));

  global.utilization_timeout = setTimeout(() => {
    get_utilization();
  }, 10 * 1000);
}
