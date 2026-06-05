const path = require('path')

module.exports = (env, argv) => ({
    entry: {
        index: './src/main.js'
    },
    output: {
        filename: 'bundle.js',
        path: path.resolve(__dirname, 'dist')
    },
    devtool: argv.mode === 'production' ? false : 'source-map'
})
