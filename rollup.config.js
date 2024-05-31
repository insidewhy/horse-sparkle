import babel from '@rollup/plugin-babel'
import resolve from '@rollup/plugin-node-resolve'

const extensions = ['.ts']

export default {
  input: 'src/index.ts',
  plugins: [
    resolve({ extensions }),
    babel({
      extensions,
      presets: ['@babel/typescript'],
    }),
  ],
  watch: { clearScreen: false },
  output: [{ file: 'dist.es2018/index.js', format: 'cjs' }],
}
