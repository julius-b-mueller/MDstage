const path = require('path')

module.exports = {
    entry: {
        index: './src/main.js'
    },
    output: {
        filename: 'bundle.js',
        path: path.resolve(__dirname, 'dist')
    },
    devtool: "source-map"
}