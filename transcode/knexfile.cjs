// Update with your config settings.

/**
 * @type { Object.<string, import("knex").Knex.Config> }
 */
module.exports = {
  development: {
    client: "sqlite3",
    connection: {
      filename: "/usr/app/data/transcoder.sqlite3",
    },
    useNullAsDefault: true,
  },
};
