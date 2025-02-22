import fs from "fs";
import { parseStringPromise } from "xml2js";
import logger from "./logger";

export default async function tmdb_api(file_path) {
  try {
    // first get the nfo file
    const nfo_path = file_path.replace(/\.\w+$/, ".nfo");

    // read the nfo file
    const nfo = fs.readFileSync(nfo_path, "utf8");

    // parse the nfo file
    const nfo_data = parseStringPromise(nfo);

    // extract the movie ID
    const { id: tmdb_id } = nfo_data.movie;

    // fetch the movie details from TMDB
    const url = `https://api.themoviedb.org/3/movie/${tmdb_id}?language=en-US`;
    const tmdb_data = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${process.env.TMDB_API_KEY}`,
      },
    }).then((res) => res.json());

    return tmdb_data;
  } catch (e) {
    logger.error(e, { label: "TMDB API FAILURE" });
    return false;
  }
}
