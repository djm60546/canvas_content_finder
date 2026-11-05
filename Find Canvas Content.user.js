// ==UserScript==
// @name         Find Canvas Content
// @namespace    https://github.com/djm60546/canvas_content_finder/
// @version      2.01
// @description  Script for finding code or text in multiple Canvas courses using the Canvas API. Generates a .CSV download containing the find results.
// @author       Dan Murphy, Northwestern University School of Professional Studies (dmurphy@northwestern.edu)
// @match        https://canvas.northwestern.edu/accounts/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/2.0.5/FileSaver.min.js
// @require      https://code.jquery.com/jquery-3.7.1.min.js
// @require      https://code.jquery.com/ui/1.14.2/jquery-ui.min.js
// @grant        none

// ==/UserScript==

(function() {

    'use strict';

    // Some software doesn't like spaces in the headings.
    // Set headingNoSpaces = true to remove spaces from the headings
    var headingNoSpaces = false;

    var pagesData = [];
    var coursesData = {};
    var ajaxPool = [];
    var currentRunId = 0;
    var controls = {};
    controls.aborted = false;
    controls.canvasAcct = "21"; // SPS Canvas sub-account number
    controls.courseArray = [];
    controls.courseIndex = 0
    controls.coursePending = -1;
    controls.pageIndex = 0;
    controls.pagesArray = [];
    controls.matchString;
    controls.matchRegex;
    controls.matchNoCase = false;
    controls.useRegex = false;
    controls.rsrcTypeAssgnmnts = true;
    controls.rsrcTypeDscssns = true;
    controls.rsrcTypePages = true;
    controls.rsrcTypeQuizzes = true;
    controls.rsrcTypeIdx;
    controls.contentKeyArray = ['description','message','body','description']
    controls.contentLabelArray = ['assignments','discussions','pages','quizzes']

    // Concurrency and retry configuration
    controls.initialConcurrency = 2;
    controls.minimumConcurrency = 1;
    controls.maximumConcurrency = 4;
    controls.courseConcurrency = 1;

    controls.maximumAttempts = 6;
    controls.maximum403Attempts = 3;
    controls.baseRetryDelay = 1000;
    controls.maximumRetryDelay = 30000;

    // Add a short pause when the Canvas quota becomes low.
    controls.lowQuotaThreshold = 25;
    controls.lowQuotaDelay = 500;

    // Restore concurrency gradually after successful requests.
    controls.successesBeforeIncrease = 20;

    function errorHandler(error) {
        if (isAbortError(error)) {
            console.warn('Canvas content search canceled.');
            return;
        }

        console.error(
            error.name + ': ' +
            error.message,
            error.stack || error
        );

        alert(
            'The Canvas content search could not be completed. ' +
            'See the browser console for details.'
        );

        if (!controls.aborted) {
            abortAll();
        }
    }

    function abortAll() {
        if (controls.aborted) {
            return;
        }

        controls.aborted = true;
        currentRunId++;

        requestScheduler.cancel();

        var pendingRequests = ajaxPool.slice();
        ajaxPool.length = 0;

        pendingRequests.forEach(function(request) {
            try {
                request.abort();
            } catch (error) {
                console.warn('Unable to abort request.', error);
            }
        });

        wrapup(true);
    }

    // For API calls that return more than one page of results, get the URL of the next page
    function nextURL(linkHeader) {
        if (!linkHeader) {
            return null;
        }

        var links = linkHeader.split(',');

        for (var i = 0; i < links.length; i++) {
            var match = links[i].match(
                /<([^>]+)>\s*;\s*rel\s*=\s*["']next["']/i
            );

            if (match) {
                return match[1];
            }
        }

        return null;
    }

    // Create RegEx string for the search term, escape reserved characters, set RegEx flags based on user input
    function prepRegex() {

        var flags = 'g';

        if (controls.matchNoCase) {
            flags += 'i';
        }

        try {

            if (controls.useRegex) {

                // User supplied actual regex
                controls.matchRegex = new RegExp(controls.matchString,flags);

            } else {

                // Literal text search
                var escaped = String(controls.matchString).replace(/[.*+?^${}()|[\]\\]\//g,'\\$&');

                controls.matchRegex = new RegExp(escaped,flags);
            }

        } catch (error) {

            throw new Error(
                'Invalid regular expression: ' + error.message);
        }
    }

    // -----------------------------------------------------------------------------
    // Promise-based API request scheduler
    // -----------------------------------------------------------------------------

    function createAbortError() {
        var error = new Error('The report was canceled.');
        error.name = 'AbortError';
        return error;
    }

    function isAbortError(error) {
        return error && error.name === 'AbortError';
    }

    function sleep(milliseconds) {
        return new Promise(function(resolve, reject) {
            if (controls.aborted) {
                reject(createAbortError());
                return;
            }

            var timer = window.setTimeout(function() {
                if (controls.aborted) {
                    reject(createAbortError());
                } else {
                    resolve();
                }
            }, milliseconds);

            // Retain the timer so cancellation can stop pending retry delays.
            requestScheduler.timers.add(timer);
        }).finally(function() {
            // Remove completed timers from the scheduler.
            requestScheduler.timers.forEach(function(timerId) {
                // Completed timer IDs can safely be removed. Calling clearTimeout
                // for an already completed timer has no effect.
                window.clearTimeout(timerId);
                requestScheduler.timers.delete(timerId);
            });
        });
    }

    var requestScheduler = {
        queue: [],
        active: 0,
        limit: controls.initialConcurrency,
        consecutiveSuccesses: 0,
        timers: new Set(),

        schedule: function(task) {
            var scheduler = this;

            return new Promise(function(resolve, reject) {
                if (controls.aborted) {
                    reject(createAbortError());
                    return;
                }

                scheduler.queue.push({
                    task: task,
                    resolve: resolve,
                    reject: reject
                });

                scheduler.drain();
            });
        },

        drain: function() {
            var scheduler = this;

            if (controls.aborted) {
                scheduler.rejectQueued(createAbortError());
                return;
            }

            while (
                scheduler.active < scheduler.limit &&
                scheduler.queue.length > 0
            ) {
                var queuedTask = scheduler.queue.shift();
                scheduler.active++;

                Promise.resolve()
                    .then(queuedTask.task)
                    .then(queuedTask.resolve)
                    .catch(queuedTask.reject)
                    .finally(function() {
                    scheduler.active--;
                    scheduler.drain();
                });
            }
        },

    reduceConcurrency: function() {
        this.consecutiveSuccesses = 0;

        if (this.limit > controls.minimumConcurrency) {
            this.limit--;
            console.warn(
                'Canvas request concurrency reduced to ' + this.limit + '.'
            );
        }
    },

    recordSuccess: function() {
        this.consecutiveSuccesses++;

        if (
            this.limit < controls.maximumConcurrency &&
            this.consecutiveSuccesses >= controls.successesBeforeIncrease
        ) {
            this.limit++;
            this.consecutiveSuccesses = 0;

            console.info(
                'Canvas request concurrency restored to ' + this.limit + '.'
            );

            this.drain();
        }
    },

    rejectQueued: function(error) {
        while (this.queue.length > 0) {
            this.queue.shift().reject(error);
        }
    },

    cancel: function() {
        this.rejectQueued(createAbortError());

        this.timers.forEach(function(timerId) {
            window.clearTimeout(timerId);
        });

        this.timers.clear();
    },

    reset: function() {
        this.queue = [];
        this.active = 0;
        this.limit = controls.initialConcurrency;
        this.consecutiveSuccesses = 0;
        this.timers.clear();
    }
};


// -----------------------------------------------------------------------------
// Request and retry functions
// -----------------------------------------------------------------------------

function parseRetryAfter(retryAfterValue) {
    if (!retryAfterValue) {
        return null;
    }

    var seconds = Number(retryAfterValue);

    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.ceil(seconds * 1000);
    }

    var retryDate = Date.parse(retryAfterValue);

    if (!Number.isNaN(retryDate)) {
        return Math.max(0, retryDate - Date.now());
    }

    return null;
}

function calculateRetryDelay(attempt, jqXHR) {
    var retryAfter = parseRetryAfter(
        jqXHR.getResponseHeader('Retry-After')
    );

    if (retryAfter !== null) {
        return Math.min(
            retryAfter,
            controls.maximumRetryDelay
        );
    }

    var baseDelay = controls.baseRetryDelay;

    // Give Canvas more breathing room after a 403.
    if (jqXHR.status === 403) {
        baseDelay = 3000;
    }

    var exponentialDelay =
        baseDelay * Math.pow(2, attempt - 1);

    // Random jitter prevents concurrent requests from retrying together.
    var jitter = Math.floor(Math.random() * 1000);

    return Math.min(
        exponentialDelay + jitter,
        controls.maximumRetryDelay
    );
}

function isCanvasRateLimitError(jqXHR) {
    if (jqXHR.status === 429) {
        return true;
    }

    if (jqXHR.status !== 403) {
        return false;
    }

    var responseText = String(jqXHR.responseText || '');

    // Look for an explicit indication from Canvas that this is throttling.
    if (
        /rate.?limit|throttl|too many requests|request quota/i.test(
            responseText
        )
    ) {
        return true;
    }

    // A depleted Canvas API quota is also a strong indication that the
    // 403 is temporary rather than a permissions failure.
    var rateRemaining = Number(
        jqXHR.getResponseHeader('X-Rate-Limit-Remaining')
    );

    return (
        Number.isFinite(rateRemaining) &&
        rateRemaining <= 0
    );
}

function isRetryableStatus(jqXHR, textStatus, attempt) {
    if (textStatus === 'timeout') {
        return true;
    }

    if (jqXHR.status === 0 && textStatus !== 'abort') {
        return true;
    }

    if (isCanvasRateLimitError(jqXHR)) {
        return true;
    }

    // Canvas sometimes returns a transient 403 even when the response
    // doesn't clearly identify it as throttling. Retry these cautiously.
    if (
        jqXHR.status === 403 &&
        attempt < controls.maximum403Attempts
    ) {
        return true;
    }

    return [
        408,
        425,
        500,
        502,
        503,
        504
    ].includes(jqXHR.status);
}

function performAjaxRequest(url) {
    return new Promise(function(resolve, reject) {
        if (controls.aborted) {
            reject(createAbortError());
            return;
        }

        var jqXHR = $.ajax({
            url: url,
            method: 'GET',
            dataType: 'json',
            timeout: 45000,
            cache: false
        });

        ajaxPool.push(jqXHR);

        jqXHR.done(function(data, textStatus, response) {
            resolve({
                data: data,
                jqXHR: response
            });
        });

        jqXHR.fail(function(response, textStatus, errorThrown) {
            if (textStatus === 'abort' || controls.aborted) {
                reject(createAbortError());
                return;
            }

            var error = new Error(
                'Canvas request failed. HTTP ' +
                (response.status || 0) +
                ' ' +
                (errorThrown || textStatus) +
                ': ' +
                url
            );

            error.jqXHR = response;
            error.textStatus = textStatus;
            error.url = url;

            reject(error);
        });

        jqXHR.always(function() {
            var index = ajaxPool.indexOf(jqXHR);

            if (index !== -1) {
                ajaxPool.splice(index, 1);
            }
        });
    });
}

async function apiRequest(url, attempt) {
    attempt = attempt || 1;

    if (controls.aborted) {
        throw createAbortError();
    }

    try {
        var response = await requestScheduler.schedule(function() {
            return performAjaxRequest(url);
        });

        requestScheduler.recordSuccess();

        var rateRemaining = Number(
            response.jqXHR.getResponseHeader('X-Rate-Limit-Remaining')
        );

        var requestCost = Number(
            response.jqXHR.getResponseHeader('X-Request-Cost')
        );

        if (!Number.isNaN(requestCost)) {
            console.debug(
                'Canvas request cost:',
                requestCost,
                url
            );
        }

        if (
            !Number.isNaN(rateRemaining) &&
            rateRemaining < controls.lowQuotaThreshold
        ) {
            $('#ccf_report_status').text(
                'Canvas quota is low. Slowing requests...'
            );

            await sleep(controls.lowQuotaDelay);
        }

        return response;
    } catch (error) {
        if (isAbortError(error) || controls.aborted) {
            throw createAbortError();
        }

        var jqXHR = error.jqXHR || {};
        var textStatus = error.textStatus || '';

        if (
            isRetryableStatus(jqXHR, textStatus, attempt) &&
            attempt < controls.maximumAttempts
        ) {
        if (
            isCanvasRateLimitError(jqXHR) ||
            jqXHR.status === 403
        ) {
            requestScheduler.reduceConcurrency();
        }

            var delay = calculateRetryDelay(attempt, jqXHR);

            $('#ccf_report_status').text(
                'Canvas request failed. Retrying attempt ' +
                (attempt + 1) +
                ' of ' +
                controls.maximumAttempts +
                '...'
            );

            console.warn(
                'Retrying Canvas request in ' +
                delay +
                ' ms. Attempt ' +
                (attempt + 1) +
                ' of ' +
                controls.maximumAttempts +
                '.',
                url,
                error
            );

            await sleep(delay);

            return apiRequest(url, attempt + 1);
        }

        throw error;
    }
}


// -----------------------------------------------------------------------------
// Pagination
// -----------------------------------------------------------------------------

async function getAllPages(initialURL) {
    var allItems = [];
    var nextPageURL = initialURL;

    while (nextPageURL) {
        if (controls.aborted) {
            throw createAbortError();
        }

        var response = await apiRequest(nextPageURL);
        var pageItems = Array.isArray(response.data)
            ? response.data
            : [];

        allItems.push.apply(allItems, pageItems);

        nextPageURL = nextURL(
            response.jqXHR.getResponseHeader('Link')
        );
    }

    return allItems;
}


// -----------------------------------------------------------------------------
// Generic concurrent array processing
// -----------------------------------------------------------------------------

async function mapWithConcurrency(items, concurrency, iterator) {
    if (!items.length) {
        return [];
    }

    var results = new Array(items.length);
    var nextIndex = 0;

    async function worker() {
        while (true) {
            if (controls.aborted) {
                throw createAbortError();
            }

            var currentIndex = nextIndex;
            nextIndex++;

            if (currentIndex >= items.length) {
                return;
            }

            results[currentIndex] = await iterator(
                items[currentIndex],
                currentIndex
            );
        }
    }

    var workerCount = Math.min(concurrency, items.length);
    var workers = [];

    for (var i = 0; i < workerCount; i++) {
        workers.push(worker());
    }

    await Promise.all(workers);

    return results;
}


// -----------------------------------------------------------------------------
// Course and resource processing
// -----------------------------------------------------------------------------

function getSelectedResourceTypes() {
    var resourceTypes = [];

    if (controls.rsrcTypeAssgnmnts) {
        resourceTypes.push({
            label: 'assignments',
            listPath: 'assignments',
            idProperty: 'id',
            contentProperty: 'description',
            typeIndex: 0
        });
    }

    if (controls.rsrcTypeDscssns) {
        resourceTypes.push({
            label: 'discussions',
            listPath: 'discussion_topics',
            idProperty: 'id',
            contentProperty: 'message',
            typeIndex: 1
        });
    }

    if (controls.rsrcTypePages) {
        resourceTypes.push({
            label: 'pages',
            listPath: 'pages',
            idProperty: 'page_id',
            contentProperty: 'body',
            typeIndex: 2
        });
    }

    if (controls.rsrcTypeQuizzes) {
        resourceTypes.push({
            label: 'quizzes',
            listPath: 'quizzes',
            idProperty: 'id',
            contentProperty: 'description',
            typeIndex: 3
        });
    }

    return resourceTypes;
}

function shouldIncludeResource(resource, resourceType) {
    if (resourceType.label !== 'discussions') {
        return true;
    }

    // Graded discussions are also assignments. Excluding them here prevents
    // duplicate assignment and discussion results.
    if (resource.assignment !== undefined && resource.assignment !== null) {
        return false;
    }

    // Anonymous discussion contents are not extracted.
    if (resource.anonymous_state) {
        return false;
    }

    return true;
}

async function parseResource(resourceURL, course, resourceType) {
    if (controls.aborted) {
        throw createAbortError();
    }

    var response = await apiRequest(resourceURL);
    var resource = response.data;
    var content = resource[resourceType.contentProperty];

    if (typeof content !== 'string' || content.length === 0) {
        return null;
    }

    // match() with a global regex modifies lastIndex behavior in some regex
    // operations. Reset it before each resource for predictable processing.
    controls.matchRegex.lastIndex = 0;

    var matches = content.match(controls.matchRegex);
    var matchCount = matches ? matches.length : 0;

    if (matchCount === 0) {
        return null;
    }

    var result = Object.assign({}, resource);

    result.url = resourceURL.replace(
        /\/api\/v1/,
        'https://canvas.northwestern.edu'
    );

    result.course_id = course.id;
    result.matches = matchCount;

    return result;
}

async function processResourceType(course, resourceType) {
    $('#ccf_report_name').text(course.course_code || course.name);
    $('#ccf_report_status').text('Getting ' + resourceType.label + '...');

    var listURL =
        '/api/v1/courses/' +
        course.id +
        '/' +
        resourceType.listPath +
        '?per_page=100';

    var resources = await getAllPages(listURL);

    var eligibleResources = resources.filter(function(resource) {
        return shouldIncludeResource(resource, resourceType);
    });

    var completed = 0;

    var matches = await mapWithConcurrency(
        eligibleResources,
        controls.maximumConcurrency,
        async function(resource) {
            var resourceID = resource[resourceType.idProperty];

            if (
                resourceID === undefined ||
                resourceID === null
            ) {
                console.warn(
                    'Canvas resource does not have the expected ID property.',
                    resourceType.idProperty,
                    resource
                );

                return null;
            }

            var resourceURL =
                '/api/v1/courses/' +
                course.id +
                '/' +
                resourceType.listPath +
                '/' +
                encodeURIComponent(resourceID);

            var result = await parseResource(
                resourceURL,
                course,
                resourceType
            );

            completed++;

            progressbar(completed, eligibleResources.length);

           $('#ccf_report_status').text('Checking ' + resourceType.label + '...');

            return result;
        }
    );

    matches
        .filter(function(result) {
            return result !== null;
        })
        .forEach(function(result) {
            pagesData.push(result);
        });
}

async function processCourse(courseID, courseNumber, totalCourses) {
    if (controls.aborted) {
        throw createAbortError();
    }

    $('#ccf_report_status').text(
        'Getting course ' +
        courseNumber +
        ' of ' +
        totalCourses +
        '...'
    );

    var response = await apiRequest(
        '/api/v1/courses/' + encodeURIComponent(courseID)
    );

    var course = response.data;

    coursesData[course.id] = {
        id: course.id,
        course_code: course.course_code || '',
        name: course.name || '',
        term: course.enrollment_term_id || ''
    };

    var resourceTypes = getSelectedResourceTypes();

    // Resource categories within a course are processed sequentially. The
    // individual resources in each category are processed concurrently.
    // This avoids submitting every course resource to the queue at once.
    for (var i = 0; i < resourceTypes.length; i++) {
        await processResourceType(course, resourceTypes[i]);
    }
}

    async function getCourseIds(initialURL) {
        $('#ccf_report_status').text('Finding matching courses...');

        var courses = await getAllPages(initialURL);
        var uniqueCourseIDs = new Set();

        courses.forEach(function(course) {
            var courseCode = String(course.course_code || '');
            var isDistanceLearning = /-DL_/.test(courseCode);
            var isCanceled = /_SECX\d\d/.test(courseCode);

            if (isCanceled) {
                console.info(
                    (course.name || courseCode) + ' - Canceled'
                );

                return;
            }

            if (
                (controls.dlCrsOnly && isDistanceLearning) ||
                !controls.dlCrsOnly
            ) {
                uniqueCourseIDs.add(course.id);
            }
        });

        return Array.from(uniqueCourseIDs);
    }

    async function runReports(courseURL, runId) {
        controls.courseArray = await getCourseIds(courseURL);
        controls.coursePending = controls.courseArray.length;

        if (controls.coursePending === 0) {
            alert(
                'No courses matched your search criteria. ' +
                'Refine your search and try again.'
            );

            wrapup();
            return;
        }

        var plural = controls.coursePending === 1 ? '' : 's';

        var confirmation =
            'The records from ' +
            controls.coursePending +
            ' course' +
            plural +
            ' will be processed. ' +
            'The search string you entered is "' +
            controls.matchString +
            '". Continue?';

        if (!window.confirm(confirmation)) {
            wrapup();
            return;
        }

        if (controls.aborted || runId !== currentRunId) {
            throw createAbortError();
        }

        prepRegex();
        progressbar();

        await mapWithConcurrency(
            controls.courseArray,
            controls.courseConcurrency,
            async function(courseID, index) {
                await processCourse(
                    courseID,
                    index + 1,
                    controls.courseArray.length
                );

                controls.coursePending--;

                $('#ccf_report_status').text(
                    'Completed ' +
                    (index + 1) +
                    ' of ' +
                    controls.courseArray.length +
                    ' courses.'
                );
            }
        );

        if (controls.aborted || runId !== currentRunId) {
            throw createAbortError();
        }

        outputReport();
    }

    async function setupReports(enrllTrm, srchBy, srchTrm) {
        controls.aborted = false;
        currentRunId++;

        var runId = currentRunId;

        ajaxPool.length = 0;
        pagesData.length = 0;

        Object.keys(coursesData).forEach(function(key) {
            delete coursesData[key];
        });

        controls.courseArray = [];
        controls.coursePending = -1;

        requestScheduler.reset();

        var enrollmentTermID =
            Number(enrllTrm) > 0
        ? '&enrollment_term_id=' +
            encodeURIComponent(enrllTrm)
        : '';

        var searchBy =
            srchBy === 'true'
        ? ''
        : '&search_by=teacher';

        var searchTerm =
            srchTrm.trim().length > 0
        ? '&search_term=' +
            encodeURIComponent(srchTrm.trim())
        : '';

        var courseURL =
            '/api/v1/accounts/' +
            encodeURIComponent(controls.canvasAcct) +
            '/courses?with_enrollments=true' +
            enrollmentTermID +
            searchTerm +
            searchBy +
            '&per_page=100';

        document.body.style.cursor = 'wait';

        try {
            await runReports(courseURL, runId);
        } catch (error) {
            if (isAbortError(error)) {
                console.info('Canvas content search canceled.');
                return;
            }

            errorHandler(error);
        }
    }

    // Report file generating functions below

  function outputReport() {
    if (controls.aborted) {
        return;
    }

    $('#ccf_report_status').text('Compiling report...');

    try {
        var csv = createCSV();

        var searchFragment = String($('#ccf_string_inpt').val() || '').substring(0, 9);

        var cleanFragment = searchFragment.replace( /[<>:"/\\|?*.\u0000-\u001F]/g,'!');

        var reportName = '';

        if ($('#ccf_term_slct option:selected').val() !== '0') {
            reportName += $('#ccf_term_slct option:selected').text() + ' ';
        }

        var courseSearch = String($('#ccf_srch_inpt').val() || '').trim();

        if (courseSearch) {reportName += courseSearch + ' ';
        }

        var reportLabel = controls.useRegex ? 'Regular Expression' : cleanFragment;

        reportName += 'Find -' + reportLabel + '- Report.csv';

        var blob = new Blob(
            ['\uFEFF', csv],
            {
                type: 'text/csv;charset=utf-8'
            }
        );

        saveAs(blob, reportName);
        wrapup();

    } catch (error) {
        errorHandler(error);
    }
}

function csvCell(value) {
    if (value === undefined || value === null) {
        return '';
    }

    value = String(value);

    // Prevent spreadsheet formula injection.
    if (/^[=+\-@]/.test(value)) {
        value = "'" + value;
    }

    if (/[",\r\n]/.test(value)) {
        value = '"' + value.replace(/"/g, '""') + '"';
    }

    return value;
}

    function createCSV() {
        var fields = [
            {
                name: 'Course Name',
                getValue: function(page, course) {
                    return course.name;
                }
            },
            {
                name: 'Course Code',
                getValue: function(page, course) {
                    return course.course_code;
                }
            },
            {
                name: 'Term ID',
                getValue: function(page, course) {
                    return course.term;
                }
            },
            {
                name: 'Resource Name',
                getValue: function(page) {
                    if (/\/assignments\//.test(page.url)) {
                        return page.name || page.title || '';
                    }

                    return page.title || page.name || '';
                }
            },
            {
                name: 'Matches',
                getValue: function(page) {
                    return page.matches;
                }
            },
            {
                name: 'Resource URL',
                getValue: function(page) {
                    return page.url;
                }
            }
        ];

        var CRLF = '\r\n';

        var headers = fields.map(function(field) {
            return headingNoSpaces
                ? field.name.replace(/\s+/g, '')
            : field.name;
        });

        var rows = [headers.map(csvCell).join(',')];

        pagesData.forEach(function(page) {
            var course = coursesData[page.course_id] || {};

            var row = fields.map(function(field) {
                return csvCell(field.getValue(page, course));
            });

            rows.push(row.join(','));
        });

        return rows.join(CRLF) + CRLF;
    }

    // User interface functions below

    function wrapup(wasCanceled) {
        if ($('#ccf_progress_dialog').length && $('#ccf_progress_dialog').dialog('isOpen')) {
            $('#ccf_progress_dialog').dialog('close');
        }

        requestScheduler.cancel();

        ajaxPool.length = 0;
        controls.courseArray = [];
        controls.courseIndex = 0;
        controls.coursePending = -1;
        controls.pagesArray = [];

        document.body.style.cursor = 'default';

        $('#ccf_pages_report')
            .off('click.ccf')
            .one('click.ccf', reportOptionsDlg);

        if (wasCanceled) {
            // Reset on a later event-loop turn so already-rejected promises still
            // observe the canceled state.
            window.setTimeout(function() {
                controls.aborted = false;
            }, 0);
        } else {
            controls.aborted = false;
        }
    }

    function progressbar(current, total) {
        try {
            if ($('#ccf_progress_dialog').length === 0) {initProgressDialog()}
            if (typeof total === 'undefined' || typeof current == 'undefined' || controls.aborted) {
                if ($('#ccf_progress_dialog').dialog('isOpen')) {
                    $('#ccf_progress_dialog').dialog('close');
                } else {
                    $('#ccf_progressbar').progressbar({value: false});
                    $('#ccf_progressbar_label').text('');
                    $('#ccf_progress_dialog').dialog('open');
                }
            } else {
                    var val = total > 0? Math.round((current / total) * 100) : false;
                    $('#ccf_progressbar').progressbar('option','value',val);
                    $('#ccf_progressbar_label').text(current + ' / ' + total);
            }
        } catch (e) {
            errorHandler(e);
        }
    }

    function initProgressDialog() {
        try {
            $('body').append('<div id="ccf_progress_dialog"></div>');
            $('#ccf_progress_dialog').append('<div id="ccf_report_name" style="font-size: 12pt; font-weight:bold"></div>');
            $('#ccf_progress_dialog').append('<div id="ccf_progressbar_wrapper" style="position:relative;"></div>');
            $('#ccf_progressbar_wrapper').append('<div id="ccf_progressbar"></div>');
            $("#ccf_progressbar").progressbar({value: 0});
            $('#ccf_progressbar').children().first().css({'background-color' : '#cef', 'height': '20px'});
            $('#ccf_progressbar_wrapper').append('<div id="ccf_progressbar_label" style="position: absolute; z-index: 1000; top: 0; margin-top: 0.24rem; width:100%; height:1.5rem; text-align:center; font-weight:bold"></div>');
            $('#ccf_progress_dialog').append('<div id="ccf_report_status" style="font-size: 12pt; text-align: center"></div>');
            $('#ccf_progress_dialog').dialog({
                'title' : 'Fetching Canvas Data',
                'autoOpen' : false,
                'buttons' : [ {
                    'text' : 'Cancel',
                    'click' : function() {
                        $(this).dialog('close');
                        controls.aborted = true;
                        abortAll();
                    }
                }]
            });
            $('.ui-dialog-titlebar-close').remove(); // Remove titlebar close button forcing users to use form button
        } catch (e) {
            errorHandler(e);
        }
    }


    function enableReportOptionsDlgOK() {
        var resourceSelected = $('#ccf_assngmnts_chbx').prop('checked') || $('#ccf_dscssns_chbx').prop('checked') || $('#ccf_pages_chbx').prop('checked') || $('#ccf_quizzes_chbx').prop('checked');
        if (($("#ccf_term_slct").val() != 0 || $("#ccf_srch_inpt").val() != '') && $.trim($("#ccf_string_inpt").val()) != '' && resourceSelected) {
            $('#ccf_term_slct').closest(".ui-dialog").find("button:contains('OK')").removeAttr('disabled').removeClass( 'ui-state-disabled' );;
        } else {
             $('#ccf_term_slct').closest(".ui-dialog").find("button:contains('OK')").prop("disabled", true).addClass("ui-state-disabled");
        }
    }

    function reportOptionsDlg() {
        try {
            if ($('#ccf_options_frm').length === 0) {
                // Update this array with new Canvas term IDs and labels as quarters/terms are added
                // Populates the term select menu in the "Select Report Options" dialog box
     var terms = {data:[
         {val : 0, txt: 'Select a term'},
         {val: 403, txt: '2027 Fall' },
         {val: 402, txt: '2027 Summer' },
         {val: 400, txt: '2027 Spring' },
         {val: 399, txt: '2027 Winter' },
         {val: 398, txt: '2026 Fall' },
         {val: 401, txt: '2026-2027 Academic Year' },
         {val: 397, txt: '2026 Summer' },
         {val: 396, txt: '2026 Spring' },
         {val : 393, txt: '2026 Winter'},
         {val : 392, txt: '2025 Fall'},
         {val : 395, txt: '2025-2026 Academic Year'},
         {val : 394, txt: '2025 Summer'},
         {val : 391, txt: '2025 Spring'},
         {val : 390, txt: '2025 Winter'},
         {val : 389, txt: '2024 Fall'},
         {val : 388, txt: '2024-2025 Academic Year'},
         {val : 287, txt: '2024 Summer'},
         {val : 286, txt: '2024 Spring'},
         {val : 285, txt: '2024 Winter'},
         {val : 284, txt: '2023 Fall'},
         {val : 283, txt: '2023-2024 Academic Year'},
         {val : 281, txt: '2023 Summer'},
         {val : 282, txt: '2023 Spring'},
         {val : 278, txt: '2023 Winter'},
         {val : 280, txt: '2022 Fall'},
         {val : 279, txt: '2022-2023 Academic Year'},
         {val : 166, txt: '2020 Summer'},
         {val : 165, txt: '2020 Spring'},
         {val : 164, txt: '2020 Winter'},
         {val : 163, txt: '2019 Fall'},
         {val : 129, txt: '2019-2020 Academic Year'},
         {val : 131, txt: '2019-2020 Academic Year'},
         {val : 128, txt: '2019 Summer'},
         {val : 127, txt: '2019 Spring'},
         {val : 124, txt: '2019 Winter'},
         {val : 126, txt: '2018 Fall'},
         {val : 125, txt: '2018-2019 Med Academic Year'},
         {val : 130, txt: '2018-2019 Academic Year'},
         {val : 123, txt: '2018 Summer'},
         {val : 122, txt: '2018 Spring'},
         {val : 121, txt: '2018 Winter'},
         {val : 120, txt: '2017 Fall'},
         {val : 118, txt: '2017-2018 Academic Year'},
         {val : 119, txt: '2017 Summer'},
         {val : 113, txt: '2017 Spring'},
         {val : 112, txt: '2017 Winter'},
         {val : 111, txt: '2016 Fall'},
         {val : 109, txt: '2016-2017 Academic Year'},
         {val : 110, txt: '2016 Summer'},
         {val : 107, txt: '2016 Spring'},
         {val : 106, txt: '2016 Winter'},
         {val : 105, txt: '2015 Fall'},
         {val : 108, txt: '2015-2016 Academic Year'},
         {val : 103, txt: '2015 Summer'},
         {val : 93, txt: '2015 Spring'},
         {val : 96, txt: '2015 Winter'},
         {val : 92, txt: '2014 Fall'},
         {val : 104, txt: '2014-2015 Academic Year'},
         {val : 115, txt: 'Advising Term'},
         {val : 1, txt: 'Default Term'},
         {val : 116, txt: 'Demo Term'},
         {val : 114, txt: 'Prep Site Term'},
         {val : 117, txt: 'Program Term'}
     ]};
                // Populates the reports select menu in the "Select Report Options" dialog box
                var reports = {data:[
                    {val : '0', txt: 'Select a report type'},
                    {val : 'at-risk', txt: 'At-risk Students'},
                    {val : 'access', txt: 'Course Resource Access'},
                    {val : 'instructor', txt: 'Instructor Presence'},
                    {val : 'participation', txt: 'Zero Participation'},
                ]};
                // Define "Select Report Options" dialog box
                $('body').append('<div id="ccf_options_dialog"></div>');
                $('#ccf_options_dialog').append('<form id="ccf_options_frm"></form>');
                $('#ccf_options_frm').append('<fieldset id="ccf_options_fldst"></fieldset>');
                $('#ccf_options_fldst').append('<select id="ccf_term_slct"></select>');
                $('#ccf_options_fldst').append('<br/>');
                $('#ccf_options_fldst').append('<input type="radio" name="ccf_srch_rdo" id="coursename" value="true" checked="checked">');
                $('#ccf_options_fldst').append('<label for="coursename">&nbsp;Course Name</label>');
                $('#ccf_options_fldst').append('<br/>');
                $('#ccf_options_fldst').append('<input type="radio" name="ccf_srch_rdo" id="instructorname" value="false">');
                $('#ccf_options_fldst').append('<label for="instructorname">&nbsp;Instructor Name</label>');
                $('#ccf_options_fldst').append('<br/>');
                $('#ccf_options_fldst').append('<label for="ccf_srch_inpt">Course/instructor search text:</label>');
                $('#ccf_options_fldst').append('<input type="text" id="ccf_srch_inpt" name="ccf_srch_inpt">');
                $('#ccf_options_fldst').append('<label for="ccf_string_inpt">Find text/code string:</label>');
                $('#ccf_options_fldst').append('<textarea cols="50" id="ccf_string_inpt" name="ccf_string_inpt" rows="2"></textarea>');
                $('#ccf_options_fldst').append('<br/>');
                $('#ccf_options_fldst').append('<input type="checkbox" id="ccf_case_chbx" name="ccf_case_chbx" value="true">');
                $('#ccf_options_fldst').append('<label for="ccf_case_chbx">&nbsp; Case insensitive</label>');
                $('#ccf_options_fldst').append('<br/>');
                $('#ccf_options_fldst').append('<input type="checkbox" id="ccf_regex_chbx" name="ccf_regex_chbx" value="true">');
                $('#ccf_regex_chbx').attr('title', 'Regular expressions are interpreted as JavaScript RegEx patterns. Leave unchecked for an exact text search.');
                $('#ccf_options_fldst').append('<label for="ccf_regex_chbx">&nbsp; Regular Expression search</label>');
                $('#ccf_options_fldst').append('<p>Select course resources to search:</p>');
                $('#ccf_options_fldst').append('<input type="checkbox" id="ccf_assngmnts_chbx" name="ccf_assngmnts_chbx" value="true" checked="checked">');
                $('#ccf_options_fldst').append('<label for="ccf_assngmnts_chbx">&nbsp; Assignments</label>');
                $('#ccf_options_fldst').append('<br/>');
                $('#ccf_options_fldst').append('<input type="checkbox" id="ccf_dscssns_chbx" name="ccf_dscssns_chbx" value="true" checked="checked">');
                $('#ccf_options_fldst').append('<label for="ccf_dscssns_chbx">&nbsp; Discussions</label>');
                $('#ccf_options_fldst').append('<br/>');
                $('#ccf_options_fldst').append('<input type="checkbox" id="ccf_pages_chbx" name="ccf_pages_chbx" value="true" checked="checked">');
                $('#ccf_options_fldst').append('<label for="ccf_pages_chbx">&nbsp; Pages</label>');
                $('#ccf_options_fldst').append('<br/>');
                $('#ccf_options_fldst').append('<input type="checkbox" id="ccf_quizzes_chbx" name="ccf_quizzes_chbx" value="true" checked="checked">');
                $('#ccf_options_fldst').append('<label for="ccf_quizzes_chbx">&nbsp; Quizzes</label>');

                $("#ccf_options_frm").change(function() {
                    enableReportOptionsDlgOK();
                });


                $('#ccf_options_dialog').dialog ({
                    'title' : 'Select Report Options',
                    'modal' : true,
                    'autoOpen' : false,
                    'buttons' : {
                        "OK": function () {
                            $(this).dialog("close");
                            var enrllTrmSelct = $("#ccf_term_slct option:selected").val();
                            var srchByChecked = $("input[name='ccf_srch_rdo']:checked").val();
                            var srchTermsStr = $("#ccf_srch_inpt").val();
                            controls.matchString = $("#ccf_string_inpt").val();
                            controls.matchNoCase = $("#ccf_case_chbx").prop('checked');
                            controls.useRegex = $("#ccf_regex_chbx").prop("checked");
                            controls.rsrcTypeAssgnmnts = $("#ccf_assngmnts_chbx").prop('checked');
                            controls.rsrcTypeDscssns = $("#ccf_dscssns_chbx").prop('checked');
                            controls.rsrcTypePages = $("#ccf_pages_chbx").prop('checked');
                            controls.rsrcTypeQuizzes = $("#ccf_quizzes_chbx").prop('checked');
                            void setupReports(enrllTrmSelct,srchByChecked,srchTermsStr);
                        },
                        "Cancel": function () {
                            $(this).dialog('close');
                            $('#ccf_pages_report').one('click', reportOptionsDlg);
                        }
                    }});
                $('.ui-dialog-titlebar-close').remove(); // Remove titlebar close button forcing users to use form buttons
                $('#ccf_term_slct').closest(".ui-dialog").find("button:contains('OK')").prop("disabled", true).addClass("ui-state-disabled");
                if ($('#ccf_term_slct').children('option').length === 0) { // add quarters and terms to terms select element
                    $.each(terms.data, function (key, value) {
                        $("#ccf_term_slct").append($('<option>', {
                            value: value.val,
                            text: value.txt,
                            'data-mark': value.id
                        }));
                    });
                }
            }
            //$('#ccf_options_dialog').css('z-index', '9000');
            $('#ccf_options_dialog').dialog('open');
        } catch (e) {
            errorHandler(e);
        }
    }

    // Add "Find Canvas Content" link below navigation
    function addFinderLink() {
        if ($('#ccf_pages_report').length === 0) {
            $('#section-tabs').append('<li class="section"><a id="ccf_pages_report" style="color:#f92626; cursor:pointer">Content Finder<span class="screenreader-only">Content Finder</span></a></li>');
            $('#ccf_pages_report').one('click', reportOptionsDlg);
        }
        return;
    }

    $(document).ready(function() {
        addFinderLink(); // Add reports link to page
    });
    $.noConflict(true);
}());
