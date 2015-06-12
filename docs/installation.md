Deployment / Installation / Usage
==================================

## Adding Builders
The `kitchen.js` script is used to manage the server. To create a new builder,
use the `builder:create` command.

## Testing
The server needs a TLS keypair for communication with the clients. Generate one
(self-signed) with:
```bash
openssl req -x509 -newkey rsa:2048 -keyout server.key -out server.crt -nodes \
  -subj "/C=YourCountry/ST=YourState/L=YourLocation/O=YourName/CN=CommonName"
```

## Deployment
Make sure to install the `npm` dependencies using `npm install --production`.

Kitchen has logging built-in using the npm `debug` package. To enable it,
set the `DEBUG` environment variable to `*`, or launch the app with it,
e.g. `DEBUG=* node index.js`. You can pipe output to a logfile using
`3>>your/log/file`.
