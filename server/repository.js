/*
 * Copyright 2015 Haiku, Inc. All rights reserved.
 * Distributed under the terms of the MIT License.
 *
 * Authors:
 *		Augustin Cavalier <waddlesplash>
 */

var log = require('debug')('kitchen:repository');

var primaryArches = ['x86_gcc2', 'x86', 'x86_64'],
	secondaryArches = ['x86_gcc2:x86', 'x86:x86_gcc2'];

/**
  * @class RepositoryManager
  * @description Creates a new RepositoryManager object.
  *
  * The RepositoryManager is the high-level manager that takes care of scheduling
  * builds, transferring files, and building the HPKR files for distribution.
  *
  * @param {BuilderManager} builderManager The global BuilderManager instance.
  * @param {BuildsManager} buildsManager The global BuildsManager instance.
  */
module.exports = function (builderManager, buildsManager) {
	/**
	  * Creates a job to build the specified recipes.
	  * @param {array} recipes The recipes to build.
	  * @param {string} desc The description of the build.
	  */
	this.createJobToBuildRecipes = function (recipes, desc) {
		var build = {
			description: desc ? desc : 'build recipes',
			architecture: 'x86_64', // TODO
			steps: [], // TODO: multitask, TODO: -j<NUM>
			handleResult: function (step, exitcode, output) {
				return (exitcode == 0);
			},
			onSuccess: function () {
				// TODO: fetch files
			}
		};
		for (var i in recipes) {
			build.steps.push({command: 'haikuporter --get-dependencies ' + recipes[i]});
		}
		buildsManager.addBuild(build);
	}
}
