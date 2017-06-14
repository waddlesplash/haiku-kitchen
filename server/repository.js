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

// NOTE: if you change this, you MUST update the 'no-secondary-arch' glob below!
var arches = [
	['any'],
	['x86_gcc2', 'x86'],
//	['x86', 'x86_gcc2'],
//	['x86_64']
];
var assumeSatisfied = [
	// Assume these packages are already available in some form.
	// The installation guide specifically notes to install them.
	'gcc',
	'coreutils',
	'zlib',
	'binutils',
	'libtool',
	'gawk',
	'make',
	'bison',
	'flex',
	'grep',
	'sed',
	'tar',
	'autoconf', 'automake',
	'gettext',
	'bash',
	'file',
];
var haikuProvides = JSON.parse(fs.readFileSync('haiku_packages.json'), {encoding: 'UTF-8'});

if (!shell.which('package_repo')) {
	console.error('FATAL: package_repo (Haiku tool) must be installed.');
	process.exit(1);
}
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
	global.transfer_app.use(express.static('data/packages/'));
	var thisThis = this;

	/// Returns the HPKG name, optionally in glob syntax
	/// NOTE that if you add any secondary arches, you MUST update the no-secondary-arch glob!
	function hpkgName(recipe, arch, globbable) {
		return recipe.name + (globbable ? '!(_x86*)-' : '-') +
			recipe.version + '-' +
			recipe.revision + '-' +
			(arch === false ? recipe.arch : arch) + '.hpkg';
	}

	this._getAvailableAnyArchPackages = function (putInto) {
		var anyArchProcessedRecipes = this._buildDependencyGraph('any', '', true);
		for (var i in anyArchProcessedRecipes) {
			if (anyArchProcessedRecipes[i].available)
				putInto[anyArchProcessedRecipes[i].name] = anyArchProcessedRecipes[i];
		}
	};

	/**
	  * @private
	  * @memberof! RepositoryManager.prototype
	  * @description Rebuilds the package repository for the specified arch, hrev, and ports.
	  */
	this._updatePackageRepo = function (arch, hrev, ports) {
		var packages = [], fetchablePorts = 0, fetchedPorts = 0,
			afterPackagesAreFetched, repoPath, afterPackagesAreSymlinked, afterPackageRepoExits;
		if (arch == 'any')
			return;
		thisThis._getAvailableAnyArchPackages(ports);
		for (var i in ports) {
			fetchablePorts++;
			glob('data/packages/' + hpkgName(ports[i], false, true), function (err, files) {
				packages = packages.concat(files);
				fetchedPorts++;
				if (fetchedPorts == fetchablePorts)
					afterPackagesAreFetched();
			});
		}
		afterPackagesAreFetched = function () {
			if (!fs.existsSync('data/repository/' + arch)) {
				fs.mkdirSync('data/repository/' + arch);
			}
			repoPath = process.cwd() + '/data/repository/' + arch + '/for_hrev' + hrev + '/';
			if (fs.existsSync(repoPath)) {
				shell.rm('-rf', repoPath);
			}
			fs.mkdirSync(repoPath);
			fs.symlink(process.cwd() + '/data/packages/', repoPath + 'packages', function (err) {
				if (err && err.code != 'EEXIST') {
					log('FAILED symlink:');
					log(err);
					return;
				}
				afterPackagesAreSymlinked();
			});
		};
		afterPackagesAreSymlinked = function () {
			var repoInfo = fs.readFileSync('data/repo.info.template', {encoding: 'UTF-8'});
			repoInfo = repoInfo
				.replace(/\$HREV\$/g, hrev)
				.replace(/\$ARCH\$/g, arch)
				.replace(/\$URL\$/g, arch + '/for_hrev' + hrev + '/');
			fs.writeFileSync(repoPath + 'repo.info', repoInfo);
			var packageslst = packages.join("\n").replace(/data\//g, '');
			fs.writeFile(repoPath + 'packages.lst', packageslst, function (err) {
				if (err) {
					log('FAILED to write repo.info:');
					log(err);
					return;
				}
				// TODO: Patch package_repo so 'create' doesn't require at least one package
				var cmd = 'package_repo create repo.info ' + packages[0].replace('data/', '');
				var result = shell.exec('cd ' + repoPath + ' && ' + cmd, {silent: true});
				if (result.code !== 0) {
					log("FAILED to run 'package_repo create': (exited with: %d): %s", result.code, result.output);
					return;
				}
				cmd = 'package_repo update repo repo packages.lst';
				shell.exec('cd ' + repoPath + ' && ' + cmd, {silent: true}, function (code, output) {
					if (code !== 0) {
						log("FAILED to run 'package_repo update': (exited with: %d): %s", code, output);
						// fall through: try to run SHA256sum anyway (lol package_repo)
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
					try { fs.unlinkSync('data/repository/' + arch + '/current'); } catch (e) { /* ENOENT? */ }
					fs.symlink(repoPath, 'data/repository/' + arch + '/current', function (err) {});
					log('repository update for arch %s complete', arch);
				});
			});
		};
	};

	/**
	  * @private
	  * @memberof! RepositoryManager.prototype
	  * @description Private handler for _dependencyGraphFor().
	  */
	this._buildDependencyGraph = function (arch, secondaryArch, justReturnProcessedRecipes) {
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
				var provides = [], requires = [], build_requires = [];
				for (var i in recipe.provides) {
					var procd = processItem(recipe.provides[i], recipe, secondaryArchSuffix);
					if (procd.length === 0)
						continue;
					provides.push(procd);
				}
				for (var i in recipe.requires) {
					var procd = processItem(recipe.requires[i], recipe, secondaryArchSuffix);
					if (procd.length === 0)
						continue;
					requires.push(procd);
				}
				for (var i in recipe.build_requires) {
					var procd = processItem(recipe.build_requires[i], recipe, secondaryArchSuffix);
					if (procd.length === 0)
						continue;
					build_requires.push(procd);
				}
				processedRecipes[recipe.name + secondaryArchSuffix] = {
					name: recipe.name + secondaryArchSuffix,
					version: recipe.version,
					revision: recipe.revision,
					provides: provides,
					requires: requires,
					build_requires: build_requires,

					available: fs.existsSync('data/packages/' + hpkgName(recipe, arch)),
					arch: arch
				};
			}
		}
		var graph, toDownload = {};
		function processRequire(name, require, discardIfSameRecipe) {
			if (haikuProvides.indexOf(require) != -1)
				return; // provided by one of the base Haiku packages

			// Iterate over everything and try to find what provides this.
			var satisfied = false;
			for (var k in processedRecipes) {
				var curProcdRecipe = processedRecipes[k];
				if (curProcdRecipe.provides.indexOf(require) != -1) {
					if (discardIfSameRecipe && curProcdRecipe.name == name) {
						// discard, it's the same recipe
					} else if (assumeSatisfied.indexOf(curProcdRecipe.name) != -1 ||
							assumeSatisfied.indexOf(curProcdRecipe.name.replace(
								'_' + secondaryArch, '')) != -1) {
						// assume this dep is satisfied
					} else if (curProcdRecipe.available) {
						if (!curProcdRecipe.willDownload) {
							toDownload[curProcdRecipe.name] = curProcdRecipe;
							curProcdRecipe.willDownload = true;
						}
						graph.addDependency(name, curProcdRecipe.name);
					} else {
						graph.addDependency(name, curProcdRecipe.name);
					}
					satisfied = true;
					break;
				}
			}
			if (!satisfied)
				graph.addDependency(name, '__broken');
		}

		processHighestVersions(highestVersionForArch, '');
		processHighestVersions(highestVersionForSecondaryArch, '_' + secondaryArch);
		if (justReturnProcessedRecipes)
			return processedRecipes;

		// Some packages may depend on any-arch packages; so get them now.
		this._getAvailableAnyArchPackages(processedRecipes);

		// Build dependency list
		graph = new DepGraph();
		graph.addNode('__broken');
		graph.addNode('__available');
		for (var i in processedRecipes) {
			graph.addNode(processedRecipes[i].name);
			if (processedRecipes[i].available)
				graph.addDependency(processedRecipes[i].name, '__available');
		}
		for (var i in processedRecipes) {
			var recipe = processedRecipes[i];
			if (!recipe.available) {
				for (var j in recipe.build_requires)
					processRequire(recipe.name, recipe.build_requires[j]);
			} else {
				for (var j in recipe.requires)
					processRequire(recipe.name, recipe.requires[j], true);
			}
		}
		graph.dependantsOf('__broken').forEach(function (n) { graph.removeNode(n); });
		graph.removeNode('__broken');
		// If we're downloading packages, we need to download their deps too
		for (var i in toDownload) {
			var deps, depndts;
			try {
				deps = graph.dependenciesOf(toDownload[i].name);
				depndts = graph.dependantsOf(toDownload[i].name);
			} catch (e) {
				// Probably was removed because broken. Skip.
				break;
			}
			for (var j in deps) {
				if (deps[j] == "__available") {
					// Don't do any of the following things; just remove it.
				} else if (processedRecipes[deps[j]].available) {
					var dep = processedRecipes[deps[j]];
					if (!dep.willDownload) {
						toDownload[dep.name] = dep;
						dep.willDownload = true;
					}
				} else {
					// Make sure all the dependants of i depend on this
					for (var k in depndts) {
						graph.addDependency(depndts[k], deps[j]);
					}
				}
				graph.removeDependency(toDownload[i], deps[j]);
			}
			graph.removeNode(toDownload[i].name);
		}
		graph.dependantsOf('__available').forEach(function (n) { graph.removeNode(n); });
		graph.removeNode('__available');
		return {graph: graph, toDownload: toDownload, ports: processedRecipes};
	};

	/**
	  * @private
	  * @memberof! RepositoryManager.prototype
	  * @description Determines what ports need to be built.
	  * @param {string} arch The primary architecture to build for.
	  */
	this._dependencyGraphFor = function (arch, secondaryArch) {
		var ignoreError = false;
		try {
			var retval = this._buildDependencyGraph(arch, secondaryArch);
			var itms = retval.graph.overallOrder(); // so we catch any possible exceptions
			if (itms.length === 0) {
				ignoreError = true;
				throw "no recipes not already built on current version";
			}
			return retval;
		} catch (e) {
			if (ignoreError)
				return;
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
				handleResult: function (step, exitcode, output) {
					// Always called as "build.handleResult", so 'this' will be 'build'
					if (exitcode !== 0) {
						step.status = 'failed';
						var splitd = step.command.split(' '),
							recipeName = splitd[1];
						if (splitd[0] != 'haikuporter')
							return false;
						var deps = this.extradata_graph.dependantsOf(recipeName);
						for (var i in deps) {
							for (var j in this.steps) {
								var stepAt = this.steps[j], splitStepAt = stepAt.command.split(' ');
								if (splitStepAt[0] != 'haikuporter')
									continue;
								if (splitStepAt[1] == deps[i])
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

			for (var j in retval.toDownload) {
				var globd = glob.sync('data/packages/' + hpkgName(retval.toDownload[j],
					arches[i][0], true));
				for (var k in globd) {
					if (globd[k].indexOf("source.hpkg") != -1)
						continue;
					var command = 'cd ~/haikuports/packages && ' +
						'wget --no-check-certificate https://KITCHEN_SERVER_ADDRESS:5825/' +
						path.basename(globd[k]) + '; cd ~';
					build.steps.push({command: command});
				}
			}

			build.steps.push({command:
				'find ~/haikuports -type d -name "work-*" -exec rm -rf {} \\; || true'});
			build.steps.push({command:
				'find ~/haikuports -type d -name "download" -exec rm -rf {} \\; || true'});
			var recipes = graph.overallOrder();
			for (var j in recipes) {
				var command = 'haikuporter ' + recipes[j];
				build.steps.push({command: command, appendJobsFlag: true});
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
