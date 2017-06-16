Haiku Kitchen
==========================
This repository contains the server and client of Haiku's package recipe build
system.

### Basic setup
The server needs a TLS keypair for communication with the clients. Generate one
by using:
```bash
openssl req -x509 -newkey rsa:4096 -sha512 -days 3650 -keyout server.key -nodes -out server.crt \
  -subj "/C=XX/ST=YourState/L=YourLocation/O=YourName/CN=haiku_kitchen"
```
and place them in the `data` folder alongside `builders.json`.

You will also need the `package_repo` command from Haiku. You can get that
by using `jam -q \<build\>package_repo` (after a `./configure --host-only`,
if you don't already have a build setup.) It will need the libraries
`libroot_build.so`, `libbe_build.so`, and `libpackage_build.so` to run.

### Adding Builders
The `kitchen.js` script is used to manage the server. To create a new builder,
use the `builder:create` command. The script will return the contents of the
`builder.conf` file that should be placed on the builder. Note that the file
contains a key that **CANNOT BE RECOVERED** by any means; so don't lose it!
Additionally, the server's `server.crt` certificate must be placed on the builder
alongside the `builder.conf`.

The following packages must also be installed on the builder:
```
gcc zlib_devel binutils libtool gawk make bison flex grep sed tar autoconf automake gettext bash file wget openssl coreutils cmd:gfortran
```
(Most of these are usually installed by default.) If the builder is a hybrid,
all the hybrid versions of the above packages must also be installed.

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
