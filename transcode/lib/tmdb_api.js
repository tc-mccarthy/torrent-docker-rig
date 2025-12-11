import fs from 'fs';
import { parseStringPromise } from 'xml2js';
import logger from './logger';
import redisClient from './redis';

function query_tmdb (url) {
  return fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${process.env.TMDB_READ_ACCESS_TOKEN}`
    }
  }).then((res) => res.json());
}

export default async function tmdb_api (file_path) {
  try {
    if (!process.env.TMDB_READ_ACCESS_TOKEN) {
      return {};
    }
    // first get the nfo file
    const nfo_path = file_path.replace(/\.\w+$/, '.nfo');

    if (!fs.existsSync(nfo_path)) {
      return {};
    }

    // read the nfo file
    const nfo = fs.readFileSync(nfo_path, 'utf8');

    // parse the nfo file
    const nfo_data = await parseStringPromise(nfo);

    // determine the video type
    const video_type = nfo_data.movie ? 'movie' : 'tv';

    if (video_type === 'movie') {
      // extract the movie ID
      const { id: tmdb_id } = nfo_data.movie;

      // check redis for the movie details
      const redis_key = `tmdb:${tmdb_id}`;
      const redis_data = await redisClient.get(redis_key);

      // if the movie details are in redis, return them
      if (redis_data) {
        logger.debug('TMDB data found in redis');
        return JSON.parse(redis_data);
      }
      logger.debug('Fetching data from TMDB');

      // fetch the movie details from TMDB
      const url = `https://api.themoviedb.org/3/movie/${tmdb_id}?language=en-US`;
      const tmdb_data = await query_tmdb(url);

      // cache the movie details in redis without an expiration
      await redisClient.set(redis_key, JSON.stringify(tmdb_data));

      return tmdb_data;
    }

    if (video_type === 'tv') {
      // find the series ID in tmdb but querying the external ID
      const { id: tvdb_id, showtitle } = nfo_data.episodedetails;

      // check redis for the series details
      const redis_key = `tvdb:${showtitle[0].toLowerCase().replace(/[^0-9A-Za-z]+/g, '')}`;
      const redis_data = await redisClient.get(redis_key);

      // if the series details are in redis, return them
      if (redis_data) {
        logger.debug('TMDB data found in redis');
        return JSON.parse(redis_data);
      }
      logger.debug('Fetching data from TMDB');

      const external_id_url = `https://api.themoviedb.org/3/find/${tvdb_id}?external_source=tvdb_id`;
      const external_id_data = await query_tmdb(external_id_url);

      if (!external_id_data.tv_episode_results?.length) {
        console.error(
          `https://api.themoviedb.org/3/find/${tvdb_id}?external_source=tvdb_id`,
          external_id_data
        );
        throw new Error('No series found in TMDB');
      }

      const tmdb_url = `https://api.themoviedb.org/3/tv/${external_id_data.tv_episode_results[0].show_id}?language=en-US`;
      const tmdb_data = await query_tmdb(tmdb_url);

      // cache the series details in redis without an expiration
      await redisClient.set(redis_key, JSON.stringify(tmdb_data));

      return tmdb_data;
    }
  } catch (e) {
    logger.error(e, { label: 'TMDB API FAILURE' });
    return {};
  }
}
