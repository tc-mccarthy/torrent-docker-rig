import fs from "fs";
import { parseStringPromise } from "xml2js";
import logger from "./logger";

function query_tmdb(url) {
  return fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${process.env.TMDB_API_KEY}`,
    },
  }).then((res) => res.json());
}

export default async function tmdb_api(file_path) {
  try {
    // first get the nfo file
    const nfo_path = file_path.replace(/\.\w+$/, ".nfo");

    // read the nfo file
    const nfo = fs.readFileSync(nfo_path, "utf8");

    // parse the nfo file
    const nfo_data = await parseStringPromise(nfo);

    // determine the video type
    const video_type = nfo_data.movie ? "movie" : "tv";

    if (video_type === "movie") {
      // extract the movie ID
      const { id: tmdb_id } = nfo_data.movie;

      // fetch the movie details from TMDB
      const url = `https://api.themoviedb.org/3/movie/${tmdb_id}?language=en-US`;
      const tmdb_data = await query_tmdb(url);

      return tmdb_data;
    }

    if (video_type === "tv") {
      // find the series ID in tmdb but querying the external ID
      const { id: tvdb_id } = nfo_data.episodedetails;
      const external_id_url = `https://api.themoviedb.org/3/find/${tvdb_id}?external_source=tvdb_id`;
      const external_id_data = await query_tmdb(external_id_url);

      if (!external_id_data.tv_results?.length) {
        console.error(`https://api.themoviedb.org/3/find/${tvdb_id}?external_source=tvdb_id`, external_id_data);
        throw new Error("No series found in TMDB");
      }

      const tmdb_url = `https://api.themoviedb.org/3/tv/${external_id_data.tv_results[0].show_id}?language=en-US`;
      const tmdb_data = await query_tmdb(tmdb_url);

      return tmdb_data;
    }
  } catch (e) {
    logger.error(e, { label: "TMDB API FAILURE" });
    return false;
  }
}
