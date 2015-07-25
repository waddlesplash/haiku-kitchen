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
	if (global.pid)
		global.pid.remove();
	process.exit(999);
});

var log = require('debug')('kitchen:index'), fs = require('fs'),
	PortsTree = require('./portstree.js'), BuildsManager = require('./builds.js'),
	BuilderManager = require('./builders.js'), RepositoryManager = require('./repository.js'),
	timers = require('timers'), zlib = require('zlib'), IRC = require('internet-relay-chat');

var argv = require('minimist')(process.argv.slice(2));
if (argv['help']) {
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

/*! ------------------------- PIDfile ------------------------- */
if (!('ignorepid' in argv)) {
	global.pid = require('npid').create('data/kitchen.pid');
	global.pid.removeOnExit();
}

/*! --------------------- haikuports tree --------------------- */
var portsTree = global.portsTree = new PortsTree();
portsTree.update();
timers.setInterval(portsTree.update, 10 * 60 * 1000);

/*! --------------------- builds/builders --------------------- */
var builderManager = global.builderManager = new BuilderManager(),
	buildsManager = global.buildsManager = new BuildsManager(builderManager);
timers.setInterval(builderManager.updateAllBuilders, 240 * 60 * 1000);

builderManager.onBuilderBroken(function (name) {
	ircNotify("Oh no! Builder '" + name +
		"' \u0003" + IRC.rawColors.lightRed + "," + IRC.rawColors.black +
		IRC.colors.bold + 'BROKE' + IRC.colors.reset + '. Somebody contact "' +
		builderManager.builders[name].data.owner + '" so they can fix it!');
});
buildsManager.onBuildFinished(function (build) {
	if (build.status != 'succeeded') {
		ircNotify('Heads up! Build #' + build.id + " ('" + build.description + "')" +
			" \u0003" + IRC.rawColors.lightRed + "," + IRC.rawColors.black +
			IRC.colors.bold + 'FAILED' + IRC.colors.reset + ' on step ' +
			(build.curStep + 1) + ' out of ' + build.steps.length +
			'. Someone please investigate!');
	}
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
			if (exitcode != 0 && exitcode != 1)
				return false;
			portsTree.recipes[step.split(' ')[2]].lint = (exitcode == 0);
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
var needToCreateLintJob = true;
for (var i in buildsManager.builds()) {
	var build = buildsManager.builds()[i]
	if (build.description == 'lint unlinted recipes'
		&& build.status == 'pending')
		needToCreateLintJob = false;
}
if (needToCreateLintJob) {
	// find recipes that need to be linted & create a build if there are some
	var recipesToLint = [];
	for (var i in portsTree.recipes) {
		if (!('lint' in portsTree.recipes[i]))
			recipesToLint.push(i);
	}
	if (recipesToLint.length > 0)
		createJobToLintRecipes(recipesToLint);
	portsTree.onRecipesChanged(function (recipes) {
		builderManager.updateAllHaikuportsTrees(function () {
			createJobToLintRecipes(recipes);
		});
	});
}

var repositoryManager = global.repositoryManager =
	new RepositoryManager(builderManager, buildsManager);

/*! ------------------------ webserver ------------------------ */
var express = require('express'), app = global.app = express();
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
	if (build == undefined) {
		response.writeHead(404, {'Content-Type': 'text/plain'});
		response.end('404 File Not Found');
		return;
	}

	var respJson = {
		id: build.id,
		status: build.status,
		builder: build.builder,
		description: build.description,
		startTime: build.startTime,
		lastTime: build.lastTime,
		steps: build.steps,
		curStep: build.curStep
	};
	response.writeHead(200, {'Content-Type': 'application/json', 'Content-Encoding': 'gzip'});
	zlib.gzip(JSON.stringify(respJson), function (err, res) {
		response.end(res);
	});
});
app.use(express.static('web'));
app.listen(argv['port']);

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

	var pendingApprovalRequest = null;
	function nullifyPendingApprovalRequest() {
		pendingApprovalRequest = null;
	}
	bot.on('message', function (sender, channel, message) {
		if (message.search(new RegExp(bot.myNick + '\\b')) != 0)
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
				"of silicon gates, screaming along at billions of cycles per second.")
			reply("And you?");
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
}
