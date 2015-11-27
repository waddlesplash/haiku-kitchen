/*
 * Copyright 2015 Haiku, Inc. All rights reserved.
 * Distributed under the terms of the MIT License.
 *
 * Authors:
 *		Augustin Cavalier <waddlesplash>
 */

var global = this;

/** @namespace */
var webApp = function () {

/** (constant) The possible architectures, in order. */
var kArchitectures = ['x86', 'x86_64', 'x86_gcc2', 'arm', 'ppc'];

function loc() {
	// window.location minus hash.
	var ret = window.location.href.replace(window.location.hash, "");
	if (ret[ret.length - 1] == '/')
		return ret.slice(0, -1);
	return ret;
}

/**
  * Get the user-friendly name for the specified status.
  * @param {string} status The status to return a friendly name for.
  * @returns {string} The user-friendly name, or the passed string if one doesn't exist.
  */
function getFriendlyNameForStatus(status) {
	if (status == 'pending')
		return 'queued';
	else if (status == 'running')
		return 'started';
	else if (status == 'partially-succeeded')
		return 'partially succeeded';
	return status;
}

/** Hides the `pageContents` area and shows the spinner. */
function hideContents() {
	$('#pageContents').hide();
	$('#loading-placeholder').show();
}
/** Hides the spinner and shows the `pageContents` area. */
function showContents() {
	$('#loading-placeholder').hide();
	$('#pageContents').show();
}

/**
  * Sets the page `<title>` and `<div id="pageTitle">`.
  * @param {string} title The of the page.
  * @param {string} description The description of the page.
  */
function setPageTitle(title, description) {
	$('title').text(title + ' | Haiku Kitchen');
	$('#pageTitle h2').text(title);
	$('#pageTitle p').html(description);
}

/**
  * Fills the page's contents with an error message.
  * @param {Object|undefined} err The `jQuery.ajax` `err` object, or `undefined`.
  */
function pageLoadingFailed(err) {
	if (err && err.status == 404)
		setPageTitle('404 Not Found', 'We can’t find that page! <i class="fa fa-frown-o"></i>');
	else
		setPageTitle('Ack!', 'Something went wrong! <i class="fa fa-frown-o"></i> Try reloading the page.');
	showContents();
}

/**
  * Runs an AJAX GET and calls a function with it as a parameter. If the page
  *   cannot be fetched, it calls {@link pageLoadingFailed} instead.
  * @param {string} pageUrl The URL of the page to fetch.
  * @param {function} func The function to call with the fetched page.
  */
function fetchPageAndCall(pageUrl, func) {
	$.ajax(loc() + pageUrl, {dataType: 'text'})
		.done(function (data) {
			func(data);
		})
		.fail(pageLoadingFailed);
}

/**
  * Performs the necessary operations on the passed homepage data and then
  *   shows the homepage.
  * @param {string} data The fetched homepage data.
  */
function showHomePage(data) {
	setPageTitle('Home', '');
	$('#pageContentsBody').html(data);
	showContents();
}

/**
  * Generates the Recipes page and shows it.
  * @param {string} data The fetched recipes pagedata.
  */
function showRecipesPage(pageData) {
	$.ajax(loc() + '/api/recipes')
		.done(function (data) {
			$('#pageContentsBody').html(pageData);

			for (var i in data) {
				var html =
					'<tr><td><i class="fa fa-file-text-o"></i> ' + data[i].name + '</td>' +
					'<td>' + data[i].category + '</td>' +
					'<td>' + data[i].version + '</td>' +
					'<td>' + data[i].revision + '</td><td>';
				if (data[i].lint === true)
					html += '<i class="fa fa-check-circle"></i><span>true</span>';
				else if (data[i].lint === false)
					html += '<i class="fa fa-times-circle"></i><span>false</span>';
				else
					html += '<i class="fa fa-question-circle"></i><span>?</span>';
				html += "</td>";
				for (var a in kArchitectures) {
					var arch = kArchitectures[a];
					html += "<td>";
					if (arch in data[i] && data[i][arch])
						html += '<a href="' + data[i][arch] + '"><i class="fa fa-archive"></i></a>';
					html += "</td>";
				}
				html += "</tr>";

				$("#recipesTableBody").append(html);
			}
			$("table.sortable").stupidtable();

			setPageTitle('Recipes', 'This is a complete listing of recipes known ' +
				'to the Haiku package build system:');
			showContents();
		})
		.fail(pageLoadingFailed);
}

/**
  * Generates the Builders page and shows it.
  * @param {string} data The fetched builders pagedata.
  */
function showBuildersPage() {
	$.ajax(loc() + '/api/builders')
		.done(function (data) {
			var onlineBuilders = 0, totalBuilders = 0;
			for (var i in data) {
				totalBuilders++;
				var html =
					'<div class="builder"><span class="heading"> ' + i + ' ';
				if (data[i].status != 'offline')
					onlineBuilders++;
				if (data[i].status == 'online')
					html += '<i class="fa fa-plug" style="color:green"></i>';
				else if (data[i].status == 'busy')
					html += '<i class="fa fa-dot-circle-o" style="color:orange"></i>';
				else if (data[i].status == 'broken')
					html += '<i class="fa fa-ban" style="color:red"></i>';
				else
					html += '<i class="fa fa-plug" style="color:lightgray"></i>';
				html += '</span>&nbsp;&nbsp;<span><b>owner:</b> ' +
						data[i].owner.replace(/<[^>]*>/g, '') + '<br>';
				if ('hrev' in data[i]) {
					html += '<a href="https://cgit.haiku-os.org/haiku/commit/?id=hrev' +
							data[i].hrev + '">hrev' + data[i].hrev + '</a>, ' +
						data[i].cores + (data[i].cores > 1 ? ' cores' : ' core') + ', ' +
						data[i].flavor + ' ' + data[i].architecture + '</div>';
				}
				$("#pageContentsBody").append(html);
			}
			setPageTitle('Builders', "<b>" + onlineBuilders +
				"</b> builders are online out of <b>" + totalBuilders + "</b>.");
			showContents();
		})
		.fail(pageLoadingFailed);
}

/**
  * Generates the Builds page and shows it.
  * @param {string} data The fetched builds pagedata.
  */
function showBuildsPage() {
	$.ajax(loc() + '/api/builds')
		.done(function (data) {
			$("#pageContentsBody").html('<table id="buildsTable"></table>');
			for (var i in data) {
				var row = '<tr class="status-' + data[i].status + '">';
				row += '<td><a href="#/build/' + data[i].id + '">#' +
					data[i].id + '</a></td>';
				row += '<td>' + data[i].description + '</td>';
				row += '<td>' + getFriendlyNameForStatus(data[i].status) +
					' ' + $.timeago(data[i].lastTime) + '</td>';
				if ('stepsSucceeded' in data[i]) {
					var stepsText = data[i].stepsSucceeded + '/' + data[i].steps;
					row += '<td>' + stepsText + ' steps</td>';
				} else
					row += '<td>' + data[i].steps + ' steps</td>';
				row += '</tr>';
				$("#buildsTable").append(row);
			}
			setPageTitle('Builds', '');
			showContents();
		})
		.fail(pageLoadingFailed);
}

/**
  * Event handler called when one of the `output` links on the Build page
  *   is clicked.
  * @param {Object} e The `onclick` event object.
  */
function buildOutput(e) {
	e.preventDefault();
	var li = $(e.target.parentNode);
	li.toggleClass('outputVisible');
	if (li.hasClass('outputVisible'))
		$(e.target).html('hide');
	else
		$(e.target).html('output');
}
global.buildOutput = buildOutput;

/**
  * Generates the Build page and shows it.
  * @param {string} pageData The fetched builds pagedata.
  */
function showBuildPage(pageData) {
	$.ajax(loc() + '/api/build/' + /[^/]*$/.exec(window.location.hash)[0])
		.done(function (data) {
			$('#pageContentsBody').html(pageData);

			$("#builderName").text(data.builder);
			$("#statusName").text(getFriendlyNameForStatus(data.status));
			$("#buildStatus").addClass('status-' + data.status);
			$("#lastTime").text($.timeago(data.lastTime));
			if ('stepsSucceeded' in data)
				$("#stepsText").text(data.stepsSucceeded + '/' + data.steps.length);
			else
				$("#stepsText").text(data.steps.length);

			if (data.status == 'running')
				$("#builtOrBuilding").text('building on');
			else if (data.status != 'failed' &&
				data.status != 'succeeded') {
				$("#builder").hide();
			} else {
				$("#duration").show();
				var duration = (new Date(data.lastTime).getTime() -
						new Date(data.startTime).getTime()), durStr = '',
					hours = Math.floor(duration / 1000 / 60 / 60);
				duration -= hours * 1000 * 60 * 60;
				var min = Math.floor(duration / 1000 / 60);
				duration -= min * 1000 * 60;
				var sec = Math.floor(duration / 1000);
				if (hours > 0)
					durStr += hours + ' hours, ';
				if (min > 0)
					durStr += min + ' minutes';
				else if (sec > 0)
					durStr += sec + ' seconds';
				$("#durationText").text(durStr);
			}

			for (var i in data.steps) {
				var status, step = data.steps[i];
				if (step.status !== undefined)
					status = step.status;
				else
					status = 'pending';
				var item = '<li class="status-' + status + '">';
				item += step.command.replace('KITCHEN_SERVER_ADDRESS', '');
				if ('output' in step) {
					item += '<a href="#" onclick="buildOutput(event);">output</a>';
					item += '<div class="textarea">' +
						step.output
							.replace(/&/g, '&amp;')
							.replace(/</g, '&lt;')
							.replace(/>/g, '&gt;')
							.replace(/\r*\n/g, '<br>')
							.replace(/ /g, '&nbsp;')
							.replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;') +
						'<br><span>Command exited with code ' + step.exitcode + '.</span>' +
						'</div>';
				}
				item += '</li>';
				$("#buildSteps").append(item);
			}

			setPageTitle('Build #' + data.id, data.description);
			showContents();
		})
		.fail(pageLoadingFailed);
}

var currentHash = '';
/**
  * Navigates to the page currently specified by `window.location.hash`.
  * @param {bool} force Whether to navigate anyway even if the current hash
  *   is identical to the previous one.
  */
function navigate(force) {
	if (currentHash == window.location.hash && !force)
		return;

	hideContents();
	$('#menu li').removeClass('active');
	$('#pageContentsBody').html('');
	setPageTitle('Loading…', '');

	if (window.location.hash.indexOf("#/build/") === 0) {
		fetchPageAndCall('pages/build.html', showBuildPage);
		currentHash = window.location.hash;
		return;
	}
	switch (window.location.hash) {
	case '':
	case '#/':
		fetchPageAndCall('pages/home.html', showHomePage);
		break;
	case '#/recipes':
		$('#menu li.recipes').addClass('active');
		fetchPageAndCall('pages/recipes.html', showRecipesPage);
		break;
	case '#/builders':
		$('#menu li.builders').addClass('active');
		showBuildersPage();
		break;
	case '#/builds':
		$('#menu li.builds').addClass('active');
		showBuildsPage();
		break;

	default:
		pageLoadingFailed({status: 404});
		currentHash = '';
		return;
	}
	currentHash = window.location.hash;
}

$(window).on('hashchange', function() {
	navigate();
});
$(function () {
	$.timeago.settings.allowFuture = true;
	navigate(true);
});

};
webApp();
