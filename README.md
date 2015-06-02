Haiku Kitchen
==========================
This repository contains the server and client of Haiku's package recipe build
system.

## Logging
Kitchen has logging built-in using the npm `debug` package. To enable it,
set the `DEBUG` environment variable to `*`, or launch the app with it,
e.g. `DEBUG=* node index.js`. You can pipe output to a logfile using
`3>>your/log/file`.
