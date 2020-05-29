// ==UserScript==
// @name         Find Canvas Content
// @namespace    https://github.com/djm60546/pages-text-content-locater
// @version      1.0
// @description  Script for finding code or text in multiple Canvas courses using the Canvas API. Generates a .CSV download containing the find results.
// @author       Dan Murphy, Northwestern University School of Professional Studies (dmurphy@northwestern.edu)
// @match        https://canvas.northwestern.edu/accounts/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/1.3.3/FileSaver.js
// @require      https://code.jquery.com/jquery-3.4.1.js
// @require      https://code.jquery.com/ui/1.12.1/jquery-ui.js
// @grant        none

// ==/UserScript==

(function() {

    'use strict';

    // Some software doesn't like spaces in the headings.
    // Set headingNoSpaces = true to remove spaces from the headings
    var headingNoSpaces = false;

    var pagesData = [];
    var coursesData = {};
    var currCourse = {};
    var ajaxPool;
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
    controls.multiLine = false;
    controls.rsrcTypeIdx;
    controls.contentKeyArray = ['description','message','body','description']

    function errorHandler(e) {
        console.log(e.name + ': ' + e.message + 'at ' + e.stack);
        alert('An error occured. See browser console for details.');
        abortAll();
    }

    function abortAll() {
        for (var i = 0; i < ajaxPool.length; i++) {
            ajaxPool[i].abort();
        }
        ajaxPool = [];
        wrapup();
    }

    function nextURL(linkTxt) {
        var url = null;
        if (linkTxt) {
            var links = linkTxt.split(',');
            var nextRegEx = new RegExp('^<(.*)>; rel="next"$');
            for (var i = 0; i < links.length; i++) {
                var matches = nextRegEx.exec(links[i]);
                if (matches) {
                    url = matches[1];
                }
            }
        }
        return url;
    }

    function setupPool() {
        // console.log('setupPool');
        try {
            ajaxPool = [];
            $.ajaxSetup({
                'beforeSend' : function(jqXHR) {
                    ajaxPool.push(jqXHR);
                },
                'complete' : function(jqXHR) {
                    var i = ajaxPool.indexOf(jqXHR);
                    if (i > -1) {
                        ajaxPool.splice(i, 1);
                    }
                }
            });
        } catch (e) {
            throw new Error('Error configuring AJAX pool');
        }
    }

    //Create RegEx string, escape reserved characters, set flags based on user input
    function prepRegex() {
        const cleanRegex = RegExp(/.\+*?[^]$(){}=!<>|:-/,'g');
        var cleanMatchStr = controls.matchString.replace(cleanRegex);
        cleanMatchStr += '+';
        var regExFlags = 'g';
        if (controls.matchNoCase == true) {regExFlags += 'i'}
        if (controls.multiLine == true) {regExFlags += 'm'}
        controls.matchRegex = RegExp(cleanMatchStr, regExFlags);
    }

    function callbackController() {
        controls.rsrcTypeIdx++;
        var lURL = '/api/v1/courses/' + currCourse.id;
        switch(controls.rsrcTypeIdx) {
            case 0:
                lURL += '/assignments?per_page=100';
                getResourcesList(lURL,'id');
                break
            case 1:
                lURL += '/discussion_topics?per_page=100';
                getResourcesList(lURL,'id')
                break;
            case 2:
                lURL += '/pages?per_page=100';
                getResourcesList(lURL,'page_id')
                break;
            case 3:
                lURL += '/quizzes?per_page=100';
                getResourcesList(lURL,'id')
                break;
            case 4:
                controls.coursePending--;
                makeNewReport();
        }
    }

    //Run RegEx Match on the body attribute of each Canvas page in the selected course
    function parsePage(pURL) {
        const pathRregex = /\/api\/v1/;
        var linkURL = pURL.replace(pathRregex,'https:\/\/canvas.northwestern.edu');
        try {
            $.getJSON(pURL, function(pdata, status, jqXHR) { // Get users for the current course
                var thisPage = pdata;
                var contentAttr = controls.contentKeyArray[controls.rsrcTypeIdx];
                var str = thisPage[contentAttr];
                if (str && str != null) {
                    var match = str.match(controls.matchRegex);
                    var matchLen = match != null ? match.length : 0;
                    if (matchLen > 0) {
                        thisPage.url = linkURL;
                        thisPage.course_id = currCourse.id;
                        thisPage.matches = matchLen;
                        pagesData.push(thisPage);
                    }
                }
            }).fail(function() {
                var errorDetail = 'parsePage: ' + pURL;
                throw new Error(errorDetail);
            }).done(function () {
                checkPages();
            });
        } catch (e) {
            errorHandler(e);
        }
    }

    //Callback function to do an API call on each page in the course. Continue to next course or report output when all pages have been checked.
    function checkPages() {
        $('#ccf_report_status').text('Checking resources...');
        if (controls.pageIndex == controls.pagesArray.length) {
            callbackController();
        } else {
            progressbar(controls.pageIndex, controls.pagesArray.length);
            var rURL = controls.pagesArray[controls.pageIndex];
            parsePage(rURL);
            controls.pageIndex++;
        }
    }

    // Get the list of pages for the current course
    function getResourcesList(lURL,rsrcTypeID) {
        const regex = /\?per_page=100/;
        var urlStem = lURL.replace(regex,'');
        // console.log('getResourcesList');
        $('#ccf_report_status').text('Getting resources list...');
        if (controls.aborted) {
            console.log('Aborted at getResourcesList()');
            return false;
        }
        try {
            $.getJSON(lURL, function(ldata, status, jqXHR) { // Get users for the current course
                lURL = nextURL(jqXHR.getResponseHeader('Link')); // Get next page of results, if any
                for (var i = 0; i < ldata.length; i++) {
                    if (controls.rsrcTypeIdx == 1) { // Skip graded discussion topics to prevent the same resource included as an assigment and discussion
                        if (typeof ldata[i].assignment !== 'undefined' || ldata[i].assignment != null) {continue}
                    }
                    progressbar(i, ldata.length);
                    var rsrcID = ldata[i][rsrcTypeID];
                    var rURL = urlStem + '/' + rsrcID;
                    controls.pagesArray.push(rURL);
                }
            }).fail(function() {
                var errorDetail = 'Error getting ' + rsrcID + ' in ' + currCourse.course_id;
                throw new Error(errorDetail);
            }).done(function () {
                if (lURL) {
                    getResourcesList(lURL);
                } else {
                    if (controls.pagesArray.length === 0) {
                        callbackController();
                    }
                    else {
                        checkPages();
                    }
                }
            });
        } catch (e) {
            errorHandler(e);
        }
    }

    // Get course data one time to be applied to all pages of the current course
    function getCourseData(crsID) {
        //console.log('getCourseData');
        $('#ccf_report_status').text('Getting course data...');
        if (controls.aborted) {
            console.log('Aborted at getCourseData()');
            return false;
        }
        try {
            $('#ccf_report_status').text('Getting course data...');
            var urlCrs = '/api/v1/courses/' + crsID;
            $.getJSON(urlCrs, function(cdata, status, jqXHR) {
                if (cdata) {
                    var thisCourse = {};
                    thisCourse.id = cdata.id;
                    thisCourse.course_code = cdata.course_code;
                    thisCourse.name = cdata.name;
                    thisCourse.term = cdata.enrollment_term_id
                    coursesData[thisCourse.id] = thisCourse;
                    currCourse = cdata;
                    $('#ccf_report_name').text(cdata.course_code);
                }
            }).fail(function() {
                var errorDetail = 'course,' + currCourse.id;
                throw new Error(errorDetail);
            }).done(function () {
                callbackController();
            });
        } catch (e) {
            errorHandler(e);
        }
    }

    // Begin gathering data for the first/next course. Clear objects, vars and arrays that contain data from the previous course
    function makeNewReport() {
        // console.log('makeNewReport');
        try {
            Object.keys(currCourse).forEach(function(key) { delete currCourse[key]; });
            controls.pagesArray = [];
            controls.pageIndex = 0;
            controls.rsrcTypeIdx = -1;
            if (controls.coursePending === 0) { // Output report if no more reports are pending
                outputReport();
            } else {
                controls.aborted = false;
                controls.courseIndex = controls.courseArray.length - controls.coursePending;
                var currCourseID = controls.courseArray[controls.courseIndex];
                progressbar(0,0); // Reset progress bar
                getCourseData(currCourseID);
            }
        } catch (e) {
            errorHandler(e);
        }
    }

    // Get the Canvas course IDs that match the user's search criteria
    function getCourseIds(crsURL) {
        try {
            $.getJSON(crsURL, function(cdata, status, jqXHR) {
                crsURL = nextURL(jqXHR.getResponseHeader('Link'));
                if (cdata) {
                    for (var i = 0; i < cdata.length; i++) {
                        var thisCourse = cdata[i];
                        var goodURL = true;
                        var crsNameStr = thisCourse.course_code;
                        var dlPttrn = /-DL_/;
                        var dlStatus = dlPttrn.test(crsNameStr); // Check if a course is online by the -DL_ pattern in link text
                        if ((controls.dlCrsOnly && dlStatus) || !controls.dlCrsOnly) { // Add courses to the list; either online only or all
                            var cncldPttrn = /_SECX\d\d/;
                            var cncldStatus = cncldPttrn.test(crsNameStr); // Check if current course is cancelled with "_SECX[two digits]" in the course name
                            if (cncldStatus) {continue} // Do not include cancelled courses
                            controls.courseArray.push(thisCourse.id);
                            if (cncldStatus) {
                                console.log(thisCourse.name + ' - Cancelled');
                                controls.emptyCourse = true;
                            }
                        }
                    }
                }
            }).done(function () {
                if (crsURL) {
                    getCourseIds(crsURL);
                } else {
                    controls.coursePending = controls.courseArray.length; //Count of courses to be processed
                    if (controls.coursePending === 0) {
                        alert('No courses matched your search criteria. Refine your search and try again.');
                        wrapup();
                        return false;
                    }
                    var pluralCrs = controls.coursePending > 1 ? 's' : '';
                    var runScriptDlg = 'The records from ' + controls.coursePending + ' course' + pluralCrs + ' will be processed. ';
                    runScriptDlg += 'The search string you entered is /' + controls.matchString + '/. Continue?';
                    if (confirm(runScriptDlg) == true) {
                        progressbar(); // Display progress bar
                        prepRegex();
                        makeNewReport(); // Get user accesses for each course selected
                    } else {
                        wrapup();
                    }
                }
            }).fail(function() {
                var errorDetail = 'Error getting course IDs';
                throw new Error(errorDetail);
            });
        } catch (e) {
            errorHandler(e);
        }
    }

    // Processes user input from the report options dialog
    function setupReports(enrllTrm, srchBy, srchTrm) {
        // console.log('setupReports');
        var enrollTermID = (enrllTrm > 0) ? "&enrollment_term_id=" + enrllTrm : "";
        var searchBy = (srchBy == 'true') ? "" : "&search_by=teacher";
        var searchTrm = (srchTrm.length > 0) ? "&search_term=" + srchTrm : "";
        document.body.style.cursor = "wait";
        controls.emptyCourse = false;
        setupPool();
        var cURL = '/api/v1/accounts/' + controls.canvasAcct + '/courses?with_enrollments=true' + enrollTermID + searchTrm + searchBy + '&per_page=100';
        getCourseIds(cURL);
    }


    // Report file generating functions below

    function outputReport() {
        // console.log('outputReport');
        var reportName = '';
        var findStrSub = $('#ccf_string_inpt').val().substring(0, 9) + '-';
        const regex = new RegExp(/[<>:"\/\|?*.]/gi);
        var findStrSubClean = findStrSub.replace(regex,'!');
        try {
            if (controls.aborted) {
                console.log('Process aborted at makeReport()');
                controls.aborted = false;
                return false;
            }
            $('#ccf_report_status').text('Compiling report...');
            var csv = createCSV();
            if (csv) {
                var blob = new Blob([ csv ], {
                    'type' : 'text/csv;charset=utf-8'
                });
                reportName = $("#ccf_term_slct option:selected").val() == 0 ? '' : $("#ccf_term_slct option:selected").text() + ' ';
                reportName += $("#ccf_srch_inpt").val() == 0 ? '' : $("#ccf_srch_inpt").val() + ' ';
                reportName += 'Find -' + findStrSubClean;
                reportName +=  ' Report.csv';
                saveAs(blob, reportName);
                if (controls.coursePending > 0) {
                    makeNewReport();
                } else {
                    wrapup();
                }
            } else {
                throw new Error('Problem creating report');
            }
        } catch (e) {
            errorHandler(e);
        }
    }

    function createCSV() {
        const assignRegex = RegExp('\/assignments\/');
        var fields = [ {
            'name' : 'Course Name',
            'src' : 'c.name',
        }, {
            'name' : 'Course Code',
            'src' : 'c.course_code',
        }, {
            'name' : 'Term ID',
            'src' : 'c.term',
        }, {
            'name' : 'Resource Name',
            'src' : 'p.title',
        }, {
            'name' : 'Matches',
            'src' : 'p.matches',
        }, {
            'name' : 'Resource URL',
            'src' : 'p.url',
        }];
        var canSIS = false;
        for ( var page_id in pagesData) {
            if (pagesData.hasOwnProperty(page_id)) {
                if (typeof pagesData[page_id].sis_user_id !== 'undefined' && pagesData[page_id].sis_user_id) {
                    canSIS = true;
                    break;
                }
            }
        }
        var CRLF = '\r\n';
        var hdr = [];
        fields.map(function(e) {
            if (typeof e.sis === 'undefined' || (e.sis && canSIS)) {
                var name = (typeof headingNoSpaces !== 'undefined' && headingNoSpaces) ? e.name.replace(' ', '') : e.name;
                hdr.push(name);
            }
        });
        var t = hdr.join(',') + CRLF;
        var page, course, courseId, fieldInfo, value;
        for (var i = 0; i < pagesData.length; i++) {
            page = pagesData[i];
            courseId = page.course_id;
            course = coursesData[courseId];
            console.log(page);
            console.log(course);
            for (var j = 0; j < fields.length; j++) {
                if (typeof fields[j].sis !== 'undefined' && fields[j].sis && !canSIS) {
                    continue;
                }
                fieldInfo = fields[j].src.split('.');
                console.log(fieldInfo);
                value = fieldInfo[0] == 'p' ? page[fieldInfo[1]] : course[fieldInfo[1]];
                if (fieldInfo[1] == 'title') {
                    if (assignRegex.test(page.url)) {
                        value = page.name;
                    }
                }
                if (typeof value === 'undefined' || value === null) {
                    value = '';
                } else {
                    if (typeof value === 'string') {
                        var quote = false;
                        if (value.indexOf('"') > -1) {
                            value = value.replace(/"/g, '""');
                            quote = true;
                        }
                        if (value.indexOf(',') > -1) {
                            quote = true;
                        }
                        if (quote) {
                            value = '"' + value + '"';
                        }
                    }
                }
                if (j > 0) {
                    t += ',';
                }
                t += value;
            }
            t += CRLF;
        }
        return t;
    }

    // User interface functions below

    // Clear or reset objects, arrays and vars of all data, reset UI
    function wrapup() {
        // console.log('wrapup');
        if ($('#ccf_progress_dialog').dialog('isOpen')) {
            $('#ccf_progress_dialog').dialog('close');
        }
        Object.keys(currCourse).forEach(function(key) { delete currCourse[key]; });
        Object.keys(coursesData).forEach(function(key) { delete coursesData[key]; });
        controls.aborted = false;
        controls.courseArray = [];
        controls.courseIndex = 0;
        controls.coursePending = -1;
        controls.pagesArray = [];
        document.body.style.cursor = "default"; // Restore default cursor
        $('#ccf_pages_report').one('click', reportOptionsDlg); // Re-enable Find Content button
    }

    function progressbar(current, total) {
        try {
            if (typeof total === 'undefined' || typeof current == 'undefined') {
                if ($('#ccf_progress_dialog').length === 0) {
                    $('body').append('<div id="ccf_progress_dialog"></div>');
                    $('#ccf_progress_dialog').append('<div id="ccf_report_name" style="font-size: 12pt; font-weight:bold"></div>');
                    $('#ccf_progress_dialog').append('<div id="ccf_progressbar"></div>');
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
                                wrapup();
                            }
                        }]
                    });
                    $('.ui-dialog-titlebar-close').remove(); // Remove titlebar close button forcing users to form buttons
                }
                if ($('#ccf_progress_dialog').dialog('isOpen')) {
                    $('#ccf_progress_dialog').dialog('close');
                } else {
                    $('#ccf_progressbar').progressbar({
                        'value' : false
                    });
                    $('#ccf_progress_dialog').dialog('open');
                }
            } else {
                if (!controls.aborted) {
                    // console.log(current + '/' + total);
                    var val = current > 0 ? Math.round(100 * current / total) : false;
                    $('#ccf_progressbar').progressbar('option', 'value', val);
                }
            }
        } catch (e) {
            errorHandler(e);
        }
    }

    function enableReportOptionsDlgOK() {
        if (($("#ccf_term_slct").val() != 0 || $("#ccf_srch_inpt").val() != '') && $.trim($("#ccf_string_inpt").val()) != '') {
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
                    {val : 168, txt: '2020 Fall'},
                    {val : 167, txt: '2020-2021 Academic Year'},
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
                $('#ccf_options_dialog').append('<form id="ccf_options_frm"></div>');
                $('#ccf_options_frm').append('<fieldset id="ccf_options_fldst"></fieldset>');
                $('#ccf_options_fldst').append('<select id="ccf_term_slct">');
                $('#ccf_options_fldst').append('<br/>');
                $('#ccf_options_fldst').append('<input type="radio" name="ccf_srch_rdo" id="coursename" value="true" checked="checked">');
                $('#ccf_options_fldst').append('<label for="coursename">&nbsp;Course Name</label>');
                $('#ccf_options_fldst').append('<br/>');
                $('#ccf_options_fldst').append('<input type="radio" name="ccf_srch_rdo" id="instructorname" value="false">');
                $('#ccf_options_fldst').append('<label for="instructorname">&nbsp;Instructor Name</label>');
                $('#ccf_options_fldst').append('<br/>');
                $('#ccf_options_fldst').append('<label for="ccf_srch_inpt">Course/instructor search text:</label>');
                $('#ccf_options_fldst').append('<input type="text" id="ccf_srch_inpt" name="ccf_srch_inpt">');
                $('#ccf_options_fldst').append('<hr/>');
                $('#ccf_options_fldst').append('<label for="ccf_string_inpt">Find text/code string:</label>');
                $('#ccf_options_fldst').append('<textarea columns="50" id="ccf_string_inpt" name="ccf_string_inpt" rows="4">');
                $('#ccf_options_fldst').append('<br/>');
                $('#ccf_options_fldst').append('<input type="checkbox" id="ccf_case_chbx" name="ccf_case_chbx" value="true">');
                $('#ccf_options_fldst').append('<label for="ccf_case_chbx">&nbsp; Case insensitive</label>');
                $('#ccf_options_fldst').append('<br/>');
                $('#ccf_options_fldst').append('<input type="checkbox" id="ccf_multi_line_chbx" name="ccf_multi_line_chbx" value="true">');
                $('#ccf_options_fldst').append('<label for="ccf_multi_line_chbx">&nbsp; Multi-line</label>');
                $("#ccf_term_slct").change(function() {
                    enableReportOptionsDlgOK();
                });
                $("#ccf_srch_inpt").change(function() {
                    enableReportOptionsDlgOK();
                });
                $("#ccf_string_inpt").change(function() {
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
                            controls.multiLine = $("#ccf_multi_line_chbx").prop('checked');
                            setupReports(enrllTrmSelct, srchByChecked, srchTermsStr);
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
                if ($('#ccf_report_slct').children('option').length === 0) { // add report types to reports select element
                    $.each(reports.data, function (key, value) {
                        $("#ccf_report_slct").append($('<option>', {
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

    // Add "Content Finder" link below navigation
    function addReportsLink() {
        if ($('#ccf_pages_report').length === 0) {
            $('#left-side').append('<div class="rs-margin-bottom"><a id="ccf_pages_report"><span aria-hidden="true" style="color:#f92626; cursor: pointer; display: block; font-size: 1rem; line-height: 20px; margin: 5px auto; padding: 8px 0px 8px 6px;">Content Finder</span><span class="screenreader-only">Content Finder</span></a></div>');
            $('#ccf_pages_report').one('click', reportOptionsDlg);
        }
        return;
    }

    $(document).ready(function() {
        addReportsLink(); // Add reports link to page
    });
    $.noConflict(true);
}());