Haiku Kitchen
==========================
This repository contains the server and client of Haiku's package recipe build
system.

Deployment / Installation / Usage
--------------------------------------

### Testing
The server needs a TLS keypair for communication with the clients. Generate one
(self-signed) with:
```bash
openssl req -x509 -newkey rsa:2048 -keyout server.key -out server.crt -nodes \
  -subj "/C=YourCountry/ST=YourState/L=YourLocation/O=YourName/CN=CommonName"
```
... and place them in the `data` folder alongside `builders.json`.

### Adding Builders
The `kitchen.js` script is used to manage the server. To create a new builder,
use the `builder:create` command. The script will return the contents of the
`builder.conf` file that should be placed on the builder. Note that the file
contains a key that **CANNOT BE RECOVERED** by any means; so don't lose it!

The following packages must also be installed on the builder:
```
gcc zlib_devel binutils libtool gawk make bison flex grep sed tar autoconf automake gettext bash file
```
If the builder is a hybrid, all the hybrid versions of the above packages must also be installed.

You will also have to add an `ip` entry to the `builder.conf` file manually
with the IP address of the server.

### Removing Builders
Builders are destroyed using `kitchen.js`'s `builder:destroy` command. Note
that only the builder's name, owner and other data contained within
`builders.json` will be deleted; builds built by the builder you are
deleting will still reference the builder by name.

### Running (development mode)
Install the `npm` dependencies with `npm install`, and then run:
```
DEBUG=*,-express*,-send node index.js --port=8081
```
On Windows, use `set DEBUG=*,-express*,-send` on a separate line instead.

### Deployment
Make sure to install the `npm` dependencies using `npm install --production`.

Kitchen has logging built-in using the
[`debug`](https://github.com/visionmedia/debug) module. To enable it,
set the `DEBUG` environment variable to `*`, or launch the app with it,
e.g. `DEBUG=* node index.js`. You can write output to a logfile using
`3>>your/log/file`.
