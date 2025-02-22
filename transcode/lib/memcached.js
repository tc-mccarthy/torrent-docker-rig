import Memcached from 'memcached-promise';

const memcached = new Memcached('memcached:11211');

export default memcached;
