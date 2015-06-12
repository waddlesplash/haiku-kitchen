Kitchen System Design
==================================
Kitchen is a server-client system for building HaikuPorts `.recipe`s into HPKG (Haiku PacKaGe) files ready for upload onto a HPKR (Haiku PacKage Repository) server. The server is designed to be run in a central location, preferably the same server the HPKR server is located on, and have the clients connect to it via TLS.

Basic Design Choices
----------------------------------
The server is written in [Node.js](https://nodejs.org/) v0.10+, and the client is written in [Python](http://python.org/) 2.7.

Node.js was chosen for the server for its event-driven processing model, easy integration with other services (HTTP[S], IRC, etc.), and large set of easily usable modules available on its package server, [npm](https://www.npmjs.com/).

Python was chosen for the client for its stability (on Haiku, compared to other languages like Ruby) and large set of default modules (JSON, TLS, etc.). Python was considered for the server, but was decided against for numerous reasons, including the fact that Python's asynchronous I/O library wasn't introduced until Python 3, which (at the time of writing) was still too unstable to be used for a production system.

Server
----------------------------------
The server is written in object-oriented Node.js. The various components are split up across multiple `.js` files, for easy navigation. Each module has its own logging keyword (e.g. `kitchen:index`) to make it easy to tell where a log message came from. The core components are as follows:
 * **`kitchen.js`**, a command-line tool for managing the server.
 * **`index.js`**, the entry point and core controller of the server, as well as all the HTTP logic
 * **`recipe.js`** (`Recipe`), parses recipe files and extracts the information out of them that the server needs.
 * **`portstree.js`** (`PortsTree`), manages the HaikuPorts tree on the server and tracks updates, etc. using `Recipe`.
 * **`builders.js`** (`BuilderManager`), manages connections from builders and builder maintenance (keeping the HaikuPorts/HaikuPorter trees on them up to date, ensuring they have the latest version of Haiku, etc.)
 * **`builds.js`** (`BuildsManager`), accepts build descriptions with list of commands to execute and then picks a builder to run them on, collects the output, and then stores it to a logfile.
 * And **`web/assets/app.js`** (`webApp`), the client-side portion of the web application, which is responsible for all page generation and navigation.

When the application starts:
 1. It initializes the `PortsTree` object.(If there is no HaikuPorts tree cloned in `cache`, it clones one (synchronously), blocking server startup until it completes the clone and initial cache rebuild.)
 2. It then creates the `BuilderManager` and `BuildsManager`, which creates the TLS server for builder connections (on port `42458`).
 3. After both of those start successfully, it then starts the HTTP webapp server (which is based on [`expressjs`](http://expressjs.com/)).
 4. It then returns into Node.js's event loop, which then dispatches events to the TLS server, HTTP server, or `PortsTree` update timer as they come in.

### `Recipe`
The `Recipe` module is composed solely of a small `.recipe` parser. It only looks for the variable definitions inside the recipes that it wants, and does not know any of Bash's syntax, so it relies on the recipes adhering to the HaikuPorts recipe styleguide. It has support for a few edgecases outside of the style guide's standards (e.g. using `'`s instead of `"`s), but these should not be taken for granted.

### `PortsTree`
The `PortsTree` module does three main things:
 1. Manages the server's clone of the HaikuPorts tree.
 2. Keeps a cache on-disk and in-memory of all the information about the recipes in the tree that Kitchen needs.
 3. Keeps a Gzipped cache (only) in-memory of all the information about recipes that the web application needs.

`PortsTree` does none of this of its own accord, but `index.js` does attach some of its routines (such as `.update()`, which runs a `git-pull` and cache update) to timer events so that they run periodically.

### `BuilderManager`
The `BuilderManager` module runs the TLS server that the builders connect to, as well as verifying the builders' identity, status, metadata (hrev, # of cores, architechture), the HaikuPorts/HaikuPorter trees and conf files on them, and keeping them up-to-date.

### `webApp`
The web application is not very object-oriented, and is generally simple. It communicates with the server via jQuery AJAX JSON GET requests, and uses the JSON resposes of the server (as well as the static page templates) to generate the webpages.

Client
----------------------------------
The client is designed to be "thin", that is, it authenticates with the server and then just does whatever it's told to do. As such, it does little more than blindly run any commands sent to it from the server.

Communication between the Server and Client
----------------------------------
Communication occurs through serialized JSON objects, followed by a single newline (`\n`) to signify the end of a message. The messages are a bit similar in design to BMessages, as they have a `what` value that identifies them.

When a builder connects, it waits for the first newline character from the server, and then sends its authentication information (name and key). Keys are generated by the command-line management tool `kitchen.js`, and consist of the SHA256 hash of 150 cryptographically-safe random bytes, digested in hexadecimal. The server has this key, hashed in SHA256 **base64** form, salted with an additional 4 cryptographically-safe random bytes.

If the client sends an incorrect key, the server immediately closes the socket and logs that a machine failed authentication, including the IP address of the machine that failed to authenticate.
