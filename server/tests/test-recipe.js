/*
 * Copyright 2015 Haiku, Inc. All rights reserved.
 * Distributed under the terms of the MIT License.
 *
 * Authors:
 *		Augustin Cavalier <waddlesplash>
 */

var Recipe = require('../recipe.js');

module.exports = {
    'generic-1.0.1': function (test) {
		var generic = new Recipe('recipe/generic-1.0.1.recipe');
        test.strictEqual(generic.name, 'generic');
		test.strictEqual(generic.version, '1.0.1');
		test.strictEqual(generic.revision, '1');
		test.strictEqual(JSON.stringify(generic.provides),
			JSON.stringify(['projectx = $portVersion', 'cmd:projectx = $portVersion']));
		test.strictEqual(JSON.stringify(generic.requires),
			JSON.stringify(['haiku']));
		test.strictEqual(JSON.stringify(generic.build_requires),
			JSON.stringify(['haiku_devel', 'cmd:make', 'cmd:gcc']));
		test.strictEqual(JSON.stringify(generic.architectures),
			JSON.stringify(['x86_gcc2', '?x86', '?x86_64']));
        test.done();
    },
	'generic_nogcc2-1.0.1': function (test) {
		var generic = new Recipe('recipe/generic_nogcc2-1.0.1.recipe');
        test.strictEqual(generic.name, 'generic_nogcc2');
		test.strictEqual(generic.version, '1.0.1');
		test.strictEqual(generic.revision, '1');
		test.strictEqual(JSON.stringify(generic.architectures),
			JSON.stringify(['x86', '?x86_64', '!x86_gcc2']));
        test.done();
    }
};
