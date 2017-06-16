/*
 * Copyright 2015 Haiku, Inc. All rights reserved.
 * Distributed under the terms of the MIT License.
 *
 * Authors:
 *		Augustin Cavalier <waddlesplash>
 */

// Attempt a graceful shutdown on exceptions
process.on('uncaughtException', function (err) {
	console.error(err.stack);
	process.exit(999);
});

var log = require('debug')('kitchen:index'), fs = require('fs'),
	PortsTree = require('./portstree.js'), BuildsManager = require('./builds.js'),
	BuilderManager = require('./builders.js'), RepositoryManager = require('./repository.js'),
	timers = require('timers'), zlib = require('zlib'), IRC = require('internet-relay-chat'),
	https = require('https');

var argv = require('minimist')(process.argv.slice(2));
if (argv.help) {
	console.log('The Kitchen server.');
	console.log('Usage: index.js [options]');
	console.log('');
	console.log('Options:');
	console.log('  --port\tPort to start the HTTP listener on.');

	process.exit(0);
}
if (!('port' in argv)) {
	argv.port = 8080;
}

log("starting up");

/*! --------------------- haikuports tree --------------------- */
var portsTree = global.portsTree = new PortsTree();
portsTree.update();
timers.setInterval(portsTree.update, 10 * 60 * 1000);

/*! ------------------------ webserver ------------------------ */
var express = require('express'), app = global.app = express(),
	transfer_app = global.transfer_app = express();

/*! --------------------- builds/builders --------------------- */
var builderManager = global.builderManager = new BuilderManager(),
	buildsManager = global.buildsManager = new BuildsManager(builderManager);

builderManager.onBuilderBroken(function (name) {
	ircNotify("Oh no! Builder '" + name + "' " +
		IRC.colors.darkRed + IRC.colors.bold + 'BROKE' + IRC.colors.reset +
		'. Somebody contact "' + builderManager.builders[name].data.owner +
		'" so they can fix it!');
});
buildsManager.onBuildFinished(function (build) {
	if (build.status == 'succeeded')
		return;
	ircNotify('Heads up! Build #' + build.id + " ('" + build.description + "') " +
		IRC.colors.darkRed + IRC.colors.bold + build.status.toUpperCase() + IRC.colors.reset +
		' (completed steps ' + build.stepsSucceeded + ' out of ' + build.steps.length +
		'. Someone please investigate!');
});

/**
  * Creates a job to lint the specified recipes.
  * @param {array} recipes The recipes to be linted.
  */
function createJobToLintRecipes(recipes, desc) {
	var build = {
		description: desc ? desc : 'lint unlinted recipes',
		architecture: 'any',
		steps: [],
		handleResult: function (step, exitcode, output) {
			if (exitcode !== 0 && exitcode != 1)
				return false;
			portsTree.recipes[step.command.split(' ')[2]].lint = (exitcode === 0);
			return true;
		},
		onSuccess: function () {
			portsTree._updateClientCache();
			portsTree._writeCache();
		}
	};
	for (var i in recipes) {
		build.steps.push({command: 'haikuporter --lint ' + recipes[i]});
	}
	buildsManager.addBuild(build);
}
portsTree.onPullFinished(function () {
	var builds = buildsManager.builds();
	for (var i in builds) {
		if (builds[i].status == 'pending' || builds[i].status == 'running')
			return; // don't start any new builds right now
	}

	var recipesToLint = [];
	for (var i in portsTree.recipes) {
		if (!('lint' in portsTree.recipes[i]))
			recipesToLint.push(i);
	}
	if (recipesToLint.length === 0)
		return; // nothing changed in the tree
	builderManager.updateAllHaikuportsTrees(function () {
		createJobToLintRecipes(recipesToLint);
		repositoryManager.buildPorts();
	});
});

var repositoryManager = global.repositoryManager =
	new RepositoryManager(builderManager, buildsManager, portsTree);

transfer_app.https_server = https.createServer({
	key: fs.readFileSync('data/server.key', 'utf8'),
	cert: fs.readFileSync('data/server.crt', 'utf8')},
transfer_app);
transfer_app.https_server.listen(5825);

app.get('/api/recipes', function (request, response) {
	response.writeHead(200, {'Content-Type': 'application/json', 'Content-Encoding': 'gzip'});
	response.end(portsTree.clientRecipes);
});
app.get('/api/builders', function (request, response) {
	var respJson = {};
	for (var i in builderManager.builders) {
		var builder = builderManager.builders[i];
		respJson[i] = {
			owner: builder.data.owner,
			memsize: builder.memsize,
			hrev: builder.hrev,
			cores: builder.cores,
			architecture: builder.data.architecture,
			flavor: builder.data.flavor,
			status: builder.status()
		};
	}
	response.writeHead(200, {'Content-Type': 'application/json'});
	response.end(JSON.stringify(respJson));
});
app.get('/api/builds', function (request, response) {
	response.writeHead(200, {'Content-Type': 'application/json'});
	response.end(JSON.stringify(buildsManager.buildsSummary()));
});
app.get('/api/build/*', function (request, response) {
	var b = /[^/]*$/.exec(request.url)[0], build = buildsManager.builds()[b];
	if (build === undefined) {
		response.writeHead(404, {'Content-Type': 'text/plain'});
		response.end('404 File Not Found');
		return;
	}

	var respJson = {
		id: build.id,
		status: build.status,
		builder: build.builderName,
		description: build.description,
		startTime: build.startTime,
		lastTime: build.lastTime,
		steps: [],
		stepsSucceeded: build.stepsSucceeded
	};
	for (var i in build.steps)
		respJson.steps.push({
			command: build.steps[i].command,
			output: !!build.steps[i].output,
			status: build.steps[i].status
		});
	response.writeHead(200, {'Content-Type': 'application/json', 'Content-Encoding': 'gzip'});
	zlib.gzip(JSON.stringify(respJson), function (err, res) {
		response.end(res);
	});
});
app.get('/api/buildstep/*', function (request, response) {
	var b = request.url.split('/'), build = b[b.length - 2], step = b[b.length - 1];
	response.writeHead(200, {'Content-Type': 'application/json', 'Content-Encoding': 'gzip'});
	zlib.gzip(JSON.stringify(buildsManager.builds()[build].steps[step]), function (err, res) {
		response.end(res);
	});
});
app.use(express.static('web'));
app.listen(argv.port, 'localhost');

/*! --------------------------- IRC --------------------------- */
var bot, ircConfig, toPost = [];
if (fs.existsSync('data/irc.json')) {
	ircConfig = JSON.parse(fs.readFileSync('data/irc.json', {encoding: 'UTF-8'}));
	bot = new IRC({
		server: 'chat.freenode.net',
		port: 6697,
		secure: true,
		username: 'walter',
		realname: 'Haiku Kitchen Bot',
		nick: ircConfig.nick
	});

	bot.on('message', function (sender, channel, message) {
		if (message.search(new RegExp(bot.myNick + '\\b')) !== 0)
			return;
		var isOp = false;
		for (var nick in bot.channels[channel].users) {
			if (nick == sender.nick &&
				bot.channels[channel].users[nick].prefix == '@') {
				isOp = true;
				break;
			}
		}
		function reply(msg) {
			bot.message(channel, sender.nick + ": " + msg);
		}
		if (!isOp) {
			reply("I don't take commands from upstarts like you. :-P");
			return;
		}

		var command = message.substr(bot.myNick.length + 1).trim().split(' ');
		switch (command[0]) {
		case 'lazy':
			reply("I build hundreds of packages at a moment's notice. I command millions " +
				"of silicon gates, screaming along at billions of cycles per second.");
			reply("And you?");
			break;
		case 'try-run-builds': {
			var res = buildsManager.tryRunBuilds();
			reply("Successfully started build%s %s; failed to start build%s %s.",
				res.succeeded.length == 1 ? "" : "s", JSON.stringify(res.succeeded),
				res.failed.length == 1 ? "" : "s", JSON.stringify(res.failed));
			break;
		}
		case 'update-all-builders':
			builderManager.updateAllBuilders();
			reply("Update started.");
			break;
		case 'help':
			reply("Available commands: 'help' (displays this), " +
				"'update-all-builders' (initates a pkgman full-sync on all idle builders)");
			break;
		default:
			reply("I ain't got a clue what you're talkin' 'bout!");
			break;
		}
	});

	bot.on('registered', function () {
		log('IRC bot connected successfully.');
		if ('password' in ircConfig)
			bot.message('NickServ', 'identify ' + ircConfig.password);
		for (var i in ircConfig.channels)
			bot.join(ircConfig.channels[i]);
		for (var i in toPost) {
			global.ircNotify(toPost[i]);
			delete toPost[i];
		}
	});
	bot.on('ctcp-version', function (line) {
		bot.ctcpReply(line.sender.nick, 'VERSION npm.internet-relay-chat + Kitchen');
	});
	bot.on('error', function (e) {});
	bot.connect();
}
global.ircNotify = function (say) {
	if (!ircConfig)
		return;
	if (!bot || !bot.registered) {
		toPost.push(say);
		return;
	}
	for (var i in ircConfig.channels)
		bot.message(ircConfig.channels[i], say);
};
