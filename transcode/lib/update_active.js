import fs from 'fs';
import { setTimeout } from 'node:timers/promises';
import exec_promise from './exec_promise';

export default async function update_active () {
  const active_list = await exec_promise(
    `find /usr/app/output/ -iname "active-*.json" -type f -mmin -${30 / 60}`
  );

  // purge inactive files
  exec_promise(
    `find /usr/app/output/ -iname "active-*.json" -type f -mtime +60 -exec rm {} \\;`
  );

  const active_files = active_list.stdout.split(/\n+/).filter((f) => f);
  const active_data = active_files.map((f) => JSON.parse(fs.readFileSync(f)));

  // sort the data by the output.size.original.kb descending
  active_data.sort(
    (a, b) => b.output.size.original.kb - a.output.size.original.kb
  );

  fs.writeFileSync(
    '/usr/app/output/pending-active.json',
    JSON.stringify(active_data)
  );
  await exec_promise(
    'mv /usr/app/output/pending-active.json /usr/app/output/active.json'
  );

  // cleanup old active files
  await exec_promise(
    'find /usr/app/output/ -iname "active-*.json" -type f -mmin +300 -exec rm {} \\;'
  );

  await setTimeout(1 * 1000); // wait 1 second before next run

  update_active();
}
