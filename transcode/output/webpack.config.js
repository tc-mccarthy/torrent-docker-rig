const path = require('path');
const ESLintLoader = require('eslint-webpack-plugin');
const PrettierLoader = require('prettier-webpack-plugin');

module.exports = {
  entry: ['./src/index.js'],
  output: {
    filename: 'bundle.js',
    path: path.resolve(__dirname, 'dist'),
    publicPath: '/dist/'
  },
  devtool: 'inline-source-map',
  devServer: {
    port: 3888, // default: 8080
    open: true, // open page in browser
    static: {
      directory: path.join(__dirname)
    }
  },
  module: {
    rules: [
      {
        test: /\.(js|jsx)$/,
        exclude: /node_modules/,
        use: ['babel-loader']
      },
      {
        test: /\.(scss|css)$/,
        use: ['style-loader', 'css-loader', 'sass-loader']
      }
    ]
  },
  plugins: [
    new ESLintLoader({
      fix: true,
      files: ['**/*.jsx', '**/*.js']
    }),
    new PrettierLoader({ extensions: ['.scss'] })
  ],
  resolve: {
    extensions: ['*', '.js', '.jsx']
  }
};
