exports.up = async function (knex) {
  await knex.schema.createTable("encoded", function (table) {
    table.string("path").primary();
    table.string("version");
    table.timestamps();
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists("encoded");
};
