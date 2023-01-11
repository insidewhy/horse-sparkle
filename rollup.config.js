const babel = require('@rollup/plugin-babel')
const resolve = require('@rollup/plugin-node-resolve')

const extensions = ['.ts']

module.exports = {
  input: 'src/index.ts',
  plugins: [
    resolve({ extensions }),
    babel({
      extensions,
      presets: ['@babel/typescript'],
    }),
  ],
  watch: { clearScreen: false },
  output: [{ file: 'dist.es2018/index.js', format: 'es' }],
}
