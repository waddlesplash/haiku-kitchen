/*
 * Copyright 2015 Haiku, Inc. All rights reserved.
 * Distributed under the terms of the MIT License.
 *
 * Authors:
 *		Augustin Cavalier <waddlesplash>
 */

var log = require('debug')('kitchen:repository'), fs = require('fs'),
	shell = require('shelljs'), path = require('path'), express = require('express'),
	IRC = require('internet-relay-chat'), glob = require('glob'),
	DepGraph = require('dependency-graph').DepGraph;

var arches = [
	['any'],
	['x86_gcc2', 'x86'],
	['x86', 'x86_gcc2'],
	['x86_64']
];
var assumeSatisfied = [
	// Assume these packages are already available in some form; they're
	// included in the default install so that should be a safe assumption
	'gcc',
	'binutils',
	'libtool',
	'gawk',
	'make',
	'bison',
	'flex',
	'grep',
	'sed',
	'tar'
];
var haikuProvides = JSON.parse(fs.readFileSync('haiku_packages.json'), {encoding: 'UTF-8'});
/*
if (!shell.which('package_repo')) {
	console.error('FATAL: package_repo (Haiku tool) must be installed.');
	process.exit(1);
}*/
if (!shell.which('sha256sum')) {
	console.error('FATAL: sha256sum (from coreutils) must be installed.');
	process.exit(1);
}
if (!fs.existsSync('data/repo.info.template')) {
	console.error('FATAL: there must be a "data/repo.info.template" file.');
	process.exit(1);
}

/**
  * @class RepositoryManager
  * @description Creates a new RepositoryManager object.
  *
  * The RepositoryManager is the high-level manager that takes care of scheduling
  * builds, transferring files, and building the HPKR files for distribution.
  *
  * @param {BuilderManager} builderManager The global BuilderManager instance.
  * @param {BuildsManager} buildsManager The global BuildsManager instance.
  * @param {PortsTree} portsTree The global PortsTree instance.
  */
module.exports = function (builderManager, buildsManager, portsTree) {
	if (!fs.existsSync('data/packages')) {
		fs.mkdirSync('data/packages');
	}
	if (!fs.existsSync('data/repository')) {
		fs.mkdirSync('data/repository');
	}
	var app = express();
	app.listen(4753);
	app.use(express.static('data/packages/'));
	var thisThis = this;

	/* Returns the HPKG name, optionally in glob syntax */
	function hpkgName(recipe, arch, globbable) {
		return recipe.name + (globbable ? '*-' : '-') +
			recipe.version + '-' +
			recipe.revision + '-' + arch + '.hpkg';
	}

	var anyArchPackages = [];
	// Technically this is a race condition, but the 'any' build will always complete
	// before the other builds, so it should be OK.

	/**
	  * @private
	  * @memberof! RepositoryManager.prototype
	  * @description Rebuilds the package repository for the specified arch, hrev, and ports.
	  */
	this._updatePackageRepo = function (arch, hrev, ports) {
		var packages = [], fetchablePorts = 0, fetchedPorts = 0,
			afterPackagesAreFetched, repoPath, afterPackagesAreSymlinked, afterPackageRepoExits;
		if (arch != 'any') {
			if (anyArchPackages.length == 0) {
				global.ircNotify("ASSERT FAILED - anyArchPackages was empty?! arch " + arch);
				log("ASSERT FAILED - anyArchPackages was empty?! arch " + arch);
				return;
			}
			packages = packages.concat(anyArchPackages);
		}
		for (var i in ports) {
			fetchablePorts++;
			glob('data/packages/' + hpkgName(ports[i], arch, true), function (err, files) {
				packages = packages.concat(files);
				fetchedPorts++;
				if (fetchedPorts == fetchablePorts)
					afterPackagesAreFetched();
			});
		}
		afterPackagesAreFetched = function () {
			if (arch == 'any') {
				// You can't have a repo with arch='any', so we store the list
				// of "any" arch packages and return.
				anyArchPackages = packages;
				return;
			}

			if (!fs.existsSync('data/repository/' + arch)) {
				fs.mkdirSync('data/repository/' + arch);
				fs.mkdirSync('data/repository/' + arch + '/by_hrev');
			}
			repoPath = process.cwd() + '/data/repository/' + arch + '/by_hrev/hrev' + hrev + '/';
			if (fs.existsSync(repoPath)) {
				shell.rm('-rf', repoPath);
			}
			fs.mkdirSync(repoPath);
			fs.mkdirSync(repoPath + 'packages');

			var symlinkedPackages = 0;
			for (var i in packages) {
				fs.symlink(process.cwd() + '/' + packages[i],
					repoPath + 'packages/' + path.basename(packages[i]),
					function (err) {
						if (err) {
							log('FAILED symlink:');
							log(err);
							return;
						}
						symlinkedPackages++;
						if (symlinkedPackages == packages.length)
							afterPackagesAreSymlinked();
					});
			}
		};
		afterPackagesAreSymlinked = function () {
			var repoInfo = fs.readFileSync('data/repo.info.template', {encoding: 'UTF-8'});
			repoInfo = repoInfo
				.replace(/\$HREV\$/g, hrev)
				.replace(/\$ARCH\$/g, arch)
				.replace(/\$URL\$/g, ''); // TODO: is this even necessary?
			fs.writeFile(repoPath + 'repo.info', repoInfo, function (err) {
				if (err) {
					log('FAILED to write repo.info:');
					log(err);
					return;
				}
				var cmd = 'package_repo create "' + repoPath + 'repo.info" "' + repoPath + 'packages"/*.hpkg';
				shell.exec(cmd, {silent: true}, function (code, output) {
					if (code !== 0) {
						log("FAILED to run 'package_repo': (exited with: %d): %s", code, output);
						return;
					}
					afterPackageRepoExits();
				});
			});
		};
		afterPackageRepoExits = function () {
			shell.exec('sha256sum ' + repoPath + 'repo', {silent: true}, function (code, output) {
				if (code !== 0) {
					log("FAILED to run 'sha256sum': (exited with: %d): %s", code, output);
					return;
				}
				fs.writeFile(repoPath + 'repo.sha256', output, function (err) {
					if (err) {
						log('FAILED to write repo.sha256:');
						log(err);
						return;
					}
					shell.rm('-rf', 'data/repository/' + arch + '/current/');
					fs.symlink(repoPath, 'data/repository/' + arch + '/current');
				});
			});
		};
	};

	/**
	  * @private
	  * @memberof! RepositoryManager.prototype
	  * @description Private handler for _dependencyGraphFor().
	  */
	this._buildDependencyGraph = function (arch, secondaryArch) {
		function versionGreaterThan (v1, v2) {
			if (v1 === undefined && v2 !== undefined)
				return true;
			if (v2 === undefined && v1 !== undefined ||
				v1 === undefined && v2 === undefined)
				return false;
			var v1a = v1.split('.'), v2a = v2.split('.');
			for (var i = 0; i < Math.min(v1.length, v2.length); i++) {
				// First see if they aren't numbers.
				var is1int = /^\d+$/.test(v1a[i]), is2int = /^\d+$/.test(v2a[i]);
				if (!is1int && !is2int) {
					if (v1a[i] != v2a[i])
						return v2a[i] > v1a[i];
					continue;
				}
				if (!is1int && is2int)
					return true;
				if (is1int && !is2int)
					return false;

				// Now interpret them as numbers.
				var v1iI = parseInt(v1a[i]), v2iI = parseInt(v2a[i]);
				if (v2iI > v1iI)
					return true;
				if (v2iI < v1iI)
					return false;
			}
			if (v2a.length > v1a.length)
				return true;
			return false;
		}

		// Pass 1: Find the highest-version recipe for the arch.
		function filterInto(object, recipes, variable, architecture) {
			if (architecture === undefined)
				return;
			for (var i in recipes) {
				var recipe = recipes[i];
				if (recipe[variable].indexOf(architecture) == -1)
					continue;
				if (object[recipe.name] === undefined ||
					versionGreaterThan(object[recipe.name].version, recipe.version)) {
					object[recipe.name] = recipe;
				}
			}
		}
		var highestVersionForArch = {}, highestVersionForSecondaryArch = {};
		filterInto(highestVersionForArch, portsTree.recipes, 'architectures', arch);
		filterInto(highestVersionForSecondaryArch, portsTree.recipes,
			'secondaryArchitectures', secondaryArch);

		// Pass 2: Replace $secondaryArchSuffix, strip versions from PROVIDES/REQUIRES in prep.
		// for passing stuff to the depsolver.
		var processedRecipes = {};
		function processItem(str, recipe, secondaryArchSuffix) {
			str = str
				.replace(/\${secondaryArchSuffix}/g, secondaryArchSuffix)
				.replace(/\$secondaryArchSuffix\b/g, secondaryArchSuffix)
				.replace(/\$portVersion\b/g, recipe.version)
				.replace(/\${portVersion}/g, recipe.version)
				.replace(/\$portName\b/g, recipe.name)
				.replace(/\${portName}/g, recipe.name);
			var byWhitespace = str.split(/\s/);
			return byWhitespace[0].toLowerCase();
		}
		function processHighestVersions(highestVersions, secondaryArchSuffix) {
			for (var i in highestVersions) {
				var recipe = highestVersions[i];
				var provides = [], requires = [];
				for (var i in recipe.provides) {
					var procd = processItem(recipe.provides[i], recipe, secondaryArchSuffix);
					if (procd.length === 0)
						continue;
					provides.push(procd);
				}
				for (var i in recipe.build_requires) {
					var procd = processItem(recipe.build_requires[i], recipe, secondaryArchSuffix);
					if (procd.length === 0)
						continue;
					requires.push(procd);
				}
				processedRecipes[recipe.name + secondaryArchSuffix] = {
					name: recipe.name + secondaryArchSuffix,
					version: recipe.version,
					revision: recipe.revision,
					provides: provides,
					requires: requires,
					available: fs.existsSync('data/packages/' + hpkgName(recipe, arch))
				};
			}
		}
		processHighestVersions(highestVersionForArch, '');
		processHighestVersions(highestVersionForSecondaryArch, '_' + secondaryArch);

		// Build dependency list
		var graph = new DepGraph(), toDownload = [], addedToGraph = 0;
		graph.addNode('broken');
		for (var i in processedRecipes) {
			if (!processedRecipes[i].available) {
				graph.addNode(processedRecipes[i].name);
				addedToGraph++;
			}
		}
		if (addedToGraph === 0) {
			throw "no recipes not already built on current version";
		}
		for (var i in processedRecipes) {
			var recipe = processedRecipes[i];
			if (assumeSatisfied.indexOf(recipe.name) != -1 ||
				assumeSatisfied.indexOf(recipe.name.replace('_' + secondaryArch, '')) != -1)
				continue; // we should already have the deps needed to build this

			for (var j in recipe.requires) {
				if (haikuProvides.indexOf(recipe.requires[j]) != -1)
					continue; // provided by one of the base Haiku packages

				// Iterate over everything and try to find what provides this.
				var satisfied = false;
				for (var k in processedRecipes) {
					var curProcdRecipe = processedRecipes[k];
					if (curProcdRecipe.provides.indexOf(recipe.requires[j]) != -1) {
						if (curProcdRecipe.available) {
							if (!curProcdRecipe.willDownload) {
								toDownload.push(curProcdRecipe);
								curProcdRecipe.willDownload = true;
							}
						} else
							graph.addDependency(recipe.name, curProcdRecipe.name);
						satisfied = true;
						break;
					}
				}
				if (!satisfied)
					graph.addDependency(recipe.name, 'broken');
			}
		}
		graph.dependantsOf('broken').forEach(function (n) { graph.removeNode(n); });
		graph.removeNode('broken');
		return {graph: graph, toDownload: toDownload, ports: processedRecipes};
	};

	/**
	  * @private
	  * @memberof! RepositoryManager.prototype
	  * @description Determines what ports need to be built.
	  * @param {string} arch The primary architecture to build for.
	  */
	this._dependencyGraphFor = function (arch, secondaryArch) {
		try {
			var retval = this._buildDependencyGraph(arch, secondaryArch);
			retval.graph.overallOrder(); // so we catch any possible exceptions
			return retval;
		} catch (e) {
			log('CATCH: _buildDependencyGraph failed (for arch %s):', arch);
			log(e);
			// Don't send the exception to IRC in case it contains sensitive information
			global.ircNotify("I tried to determine the correct order to build recipes " +
				" (for arch '" + IRC.colors.cyan + arch + IRC.colors.reset + "'), but " +
				IRC.colors.darkRed + "an exception occured" + IRC.colors.reset +
				" :/. Can someone check the logfiles and figure out why?");
		}
	};

	/**
	  * @public
	  * @memberof! RepositoryManager.prototype
	  * @description Creates jobs to build outdated ports.
	  */
	this.buildPorts = function () {
		for (var i in arches) {
			var retval = this._dependencyGraphFor(arches[i][0], arches[i][1]);
			if (retval === undefined)
				continue; // exception occured
			var graph = retval.graph;
			var build = {
				description: 'build new/updated recipes for ' + arches[i][0],
				architecture: arches[i][0],
				steps: [],
				appendJobsFlag: true,
				handleResult: function (step, exitcode, output) {
					// Always called as "build.handleResult", so 'this' will be 'build'
					if (exitcode !== 0) {
						step.status = 'failed';
						var splitd = step.command.split(' '),
							recipeName = splitd[2];
						if (splitd[0] != 'haikuporter')
							return false;
						var deps = this.extradata_graph.dependantsOf(recipeName);
						for (var i in deps) {
							for (var j in this.steps) {
								var stepAt = this.steps[j], splitStepAt = stepAt.command.split(' ');
								if (splitStepAt[0] != 'haikuporter')
									continue;
								if (splitStepAt[2] == deps[i])
									stepAt.status = 'failed';
							}
						}
					}
					return true;
				},
				extradata_ports: retval.ports,
				extradata_graph: graph,
				onSuccess: function () {
					thisThis._updatePackageRepo(this.architecture,
						builderManager.builders[this.builderName].hrev, this.extradata_ports);
				}
			};

			if (retval.toDownload.length > 0) {
				for (var j in retval.toDownload) {
					var globd = glob.sync('data/packages/' + hpkgName(retval.toDownload[j],
						arches[i][0], true));
					for (var i in globd) {
						if (globd[i].indexOf("source.hpkg") != -1)
							continue;
						var command = 'cd ~/haikuports/packages; wget KITCHEN_SERVER_ADDRESS:4753/' +
							path.basename(globd[i]) + '; cd ~';
						build.steps.push({command: command});
					}
				}
			}

			build.steps.push({command: 'find ~/haikuports -type d -name "work-*" -exec rm -rf {} \\; || true'});
			var recipes = graph.overallOrder();
			for (var j in recipes) {
				var command = 'haikuporter --no-dependencies ' + recipes[j];
				if (recipes[j].indexOf(arches[i][1]) != -1)
					command += ' --no-source-packages';
				build.steps.push({command: command});
			}
			build.steps.push({action: function (build, callback) {
				// transfer files
				var filesToTransfer = [];
				for (var i in build.steps) {
					if (build.steps[i].status != 'succeeded')
						continue;
					var lines = build.steps[i].output.split('\n');
					for (var j in lines) {
						if (lines[j].indexOf('grabbing ') === 0) {
							filesToTransfer.push(lines[j].split(' ')[6]);
						}
					}
				}
				if (filesToTransfer.length === 0) {
					log("No files to transfer?!");
					callback(-1, "No files to transfer?!");
					return;
				}

				var transferredFiles = 0, moveFiles;
				for (var i in filesToTransfer) {
					builderManager.builders[build.builderName].transferFile(filesToTransfer[i],
						function (failed) {
							if (failed) {
								callback(999999999, 'Builder disconnected');
								return;
							}
							transferredFiles++;
							if (transferredFiles == filesToTransfer.length)
								moveFiles();
						});
				}
				moveFiles = function () {
					var movedFiles = 0;
					for (var i in filesToTransfer) {
						var before = 'cache/filetransfer/' + path.basename(filesToTransfer[i]);
						var after = 'data/packages/' + path.basename(filesToTransfer[i]);
						log("moving '%s' to '%s'", before, after);
						fs.rename(before, after, function (err) {
							movedFiles++;
							if (movedFiles == filesToTransfer.length) {
								builderManager.builders[build.builderName].runCommand(
									'rm -rf ~/haikuports/packages && mkdir ~/haikuports/packages/', callback);
							}
						});
					}
				};
			}, command: 'transfer files'});
			buildsManager.addBuild(build);
		}
	};
};
