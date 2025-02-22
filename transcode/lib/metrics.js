import fs from 'fs';
import { exec } from 'child_process';
import exec_promise from './exec_promise';
import config from './config';

const { encode_version, get_paths } = config;

const PATHS = get_paths();

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

  const data = {
    memory: await exec_promise("free | grep Mem | awk '{print $3/$2 * 100.0}'"),
    cpu: await exec_promise("echo $(vmstat 1 2|tail -1|awk '{print $15}')"),
    last_updated: new Date()
  };

  data.memory = Math.round(parseFloat(data.memory.stdout));
  data.cpu = Math.round(
    100 - parseFloat(data.cpu.stdout.replace(/[^0-9]+/g, ''))
  );

  fs.writeFileSync('/usr/app/output/utilization.json', JSON.stringify(data));

  global.utilization_timeout = setTimeout(() => {
    get_utilization();
  }, 10 * 1000);
}

export async function update_status () {
  const data = {
    processed_files: await File.countDocuments({ encode_version }),
    total_files: await File.countDocuments(),
    unprocessed_files: await File.countDocuments({
      encode_version: { $ne: encode_version }
    }),
    library_coverage:
      ((await File.countDocuments({ encode_version })) /
        (await File.countDocuments())) *
      100
  };

  fs.writeFileSync('/usr/app/output/status.json', JSON.stringify(data));
}
