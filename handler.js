var ADL = require('adl-xapiwrapper');
var https = require("https");
https.globalAgent.maxSockets = 20;
var AWS = require('aws-sdk');

var conf = {
    "url" : "https://"+process.env.LRS_URL,
    "auth" : {
        user : process.env.LRS_USERNAME,
        pass : process.env.LRS_PASSWORD,
    }
};

var LRS = new ADL.XAPIWrapper(conf);
// Set the region
AWS.config.update({region: 'ap-southeast-2'});

exports.handler = async (event, context) => {
    let courses = await getCourses();
    let quizzes = await getQuizzes(courses);
    let submissions = await getQuizSubmissions(quizzes);

    /* let answers = await getSubmissionAnswers(submissions); */

    let users = await getUsers(submissions);
    let statements = await generateStatements(submissions, users, quizzes, courses);
    let inserted = await insertIntoLRS(statements);
    return inserted;
};

async function insertIntoLRS(statements) {

    let result = statements.map( async (stmt) => {
        let ts = await insertLRS(stmt);
        return ts;
    });
    const data_extract = await Promise.all(result);
    return data_extract;
}

async function getUsers(submissions) {

    let userList = [];
    for(var i = 0; i < submissions.length; i++) {
        for (var k = 0; k < submissions[i].quiz_submissions.length; k++) {
            userList.push(submissions[i].quiz_submissions[k].user_id);
        }
    }
    let usrDetails = userList.map(async (idx) => {
        let path = '/api/v1/users/'+idx+'/profile';
        return await fetchCanvasData(path);
    });

    const details = await Promise.all(usrDetails);
    return details;
}

async function generateStatements(submissions, users, quizzes, courses) {
    var statements = [];

    let lists = [];
    quizzes.forEach(ls => lists.push(...ls));

    for(var i = 0; i < submissions.length; i++) {
        for(var k = 0; k < submissions[i].quiz_submissions.length; k++) {
            let parcedSubmissionQuery = submissions[i].quiz_submissions[k].html_url.split('/');
            let courseId = parcedSubmissionQuery[4];
            let quizId = submissions[i].quiz_submissions[k].quiz_id;
            let userId = submissions[i].quiz_submissions[k].user_id;
            let user = users.find((usr) => usr.id === userId);
            let quizz = lists.find((ls) => ls.id ===quizId);
            let finish = submissions[i].quiz_submissions[k].finished_at;
            let start = submissions[i].quiz_submissions[k].started_at;
            let course = courses.find((crs) => crs.id === parseInt(courseId));
            let submission_status = submissions[i].quiz_submissions[k].workflow_state;
            let statement;


            if(typeof user !== undefined) {

                if(submission_status === 'untaken') {
                    statement = cloneInitStatement();
                    //verb
                    statement.verb.id = "http://adlnet.gov/expapi/verbs/initialized";
                    statement.verb.display["en-US"] = "initialized";

                    // finished date
                    statement.timestamp = new Date(start);

                } else {
                    statement = cloneStatement();
                    //verb
                    statement.verb.id = "http://adlnet.gov/expapi/verbs/completed";
                    statement.verb.display["en-US"] = "completed";

                    //result
                    statement.result.score.raw = submissions[i].quiz_submissions[k].score;
                    statement.result.score.scaled = submissions[i].quiz_submissions[k].score / submissions[i].quiz_submissions[k].quiz_points_possible;
                    statement.result.completion = true;

                    // finished date
                    statement.timestamp = new Date(finish);
                }


                //actor

                    statement.actor.account.name = (user.login_id === undefined ? process.env.DEFAULT_LRS_ACTOR_EMAIL : user.login_id.toLowerCase());
                    statement.actor.account.homePage = "https://"+process.env.CANVAS_API_HOST+"/profile";
                    statement.actor.name = user.name;

                    //object
                    statement.object.id = submissions[i].quiz_submissions[k].html_url;
                    //statement.object.objectType = "Activity";
                    statement.object.definition.name["en-US"] = "Quiz";
                    statement.object.definition.description["en-US"] = quizz.title;


                    //content
                    statement.context.platform = "Canvas";
                    statement.context.contextActivities.category.push({
                            "id": "https://w3id.org/xapi/scorm",
                            "definition": {
                                "type":"http://adlnet.gov/expapi/activities/profile"
                            }
                    });
                    statement.context.contextActivities.parent.push({
                        "id": "https://" + process.env.CANVAS_API_HOST + "/api/v1/courses/" + courseId,
                        "definition": {
                            "name": {
                                "en-US": course.name
                            },
                            "type": "https://" + process.env.CANVAS_API_HOST + "/api/v1/courses/" + courseId
                        }
                    });

                    //grouping
                    statement.context.contextActivities.grouping.push({
                        "id": "https://" + process.env.CANVAS_API_HOST + "/api/v1/courses/" + courseId + "/quizzes/" + quizId,
                        "definition": {
                            "name": {
                                    "en-US": quizz.title
                            },
                            "type": "https://" + process.env.CANVAS_API_HOST + "/api/v1/courses/" + courseId + "/quizzes/" + quizId
                        }
                    });

                //adding sis_course_id to contextActivities other
                if(course.sis_course_id!==null) {
                    statement.context.contextActivities.other = [];

                    statement.context.contextActivities.other.push ({
                        "id" : "https://"+process.env.CANVAS_API_HOST+"/courses/"+courseId,
                        "definition" : {
                            "name": {
                                "en-US": course.sis_course_id
                            },
                            "type": "https://" + process.env.CANVAS_API_HOST + "/courses/" + courseId
                        }
                    });
                }

                statements.push(statement);

            }
        }
    }
    return statements;
}


async function getCourses() {

    let path = '/api/v1/courses';
    return await fetchCanvasData(path);
}

async function getQuizzes(courses) {
    let qu = courses.map( async (course) => {
        let path = '/api/v1/courses/' + course.id + '/quizzes?per_page=100';
        return await fetchCanvasData(path);
    });
    const quizzes = await Promise.all(qu);
    return quizzes;
}

async function getQuizSubmissions(quizzes) {
    /*var submissions = [];
     for(var i = 0; i < quizzes.length; i++) {
        for(var k = 0; k < quizzes[i].length; k++) {
            submissions.push(await fetchDataSubmissions(quizzes[i][k].id, quizzes[i][k].html_url));
        }
    }*/

    let subs = quizzes.map ( async (quiz) => {
        let actual = quiz.map ( async (d) => {
            let parsedUrl = d.html_url.split('/');
            let courseId = parsedUrl[4];
            let path = '/api/v1/courses/' + courseId + '/quizzes/' + d.id + '/submissions?per_page=100';
            return await fetchCanvasData(path);
        });

        const fin = await Promise.all(actual);
        return fin;
    });

    const submissions = await Promise.all(subs);
    let lists = [];
    submissions.forEach(ls => lists.push(...ls));
    return lists;
}

async function getSubmissionAnswers(submissions) {
    let answers = [];

    for(let i = 0; i < submissions.length; i++) {
        for(let k = 0; k < submissions[i]["quiz_submissions"].length; k++) {
            let path = '/api/v1/quiz_submissions/' + submissions[i]["quiz_submissions"][k].id + '/questions?per_page=100';
            answers.push(await fetchCanvasData(path));
        }
    }
    return answers;
}


function insertLRS(stmts) {
    return new Promise((resolve, reject) => {
        LRS.sendStatements(stmts, (err, res) => {
            if(err) return reject(err);
            return resolve('Added');
        });
    });
}

function fetchCanvasData(path) {
    return new Promise((resolve, reject) => {
        let body = '';
        const options = {
            host: process.env.CANVAS_API_HOST,
            path: path,
            method: 'GET',
            headers: {
                'Cache-Control': 'no-cache',
                'Authorization': 'Bearer ' + process.env.CANVAS_ACCESS_TOKEN,
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        };
        const req = https.request(options, (res) => {
            res.on('data', (chunk) => {
                body += chunk;
            });
            res.on('end', () => {
                return resolve(JSON.parse(body));
            });
        });
        req.on('error', (e) => {
            reject(e.message);
        });
        req.write('');
        req.end();
    });
}

function cloneStatement() {
    let statement = {
        "actor": {
            "name": "",
            "objectType": "Agent",
            "account": {
                "homePage" : "",
                "name": ""
            }
        },
        "verb": {
            "id": "",
            "display": {"en-US": ""}
        },
        "object": {
            "id": "",
            "definition": {
                "name": {"en-US": ""},
                "description": {"en-US": ""},
                "type": "http://adlnet.gov/expapi/activities/attempt"
            }
        },
        "result": {
            "score": {
                "raw": "",
                "scaled": ""
            },
            "completion": ""
        },
        "context": {
            "platform": "",
            "contextActivities": {
                "category" : [
                ],
                "parent" : [
                ],
                "grouping" : [
                ]
            }
        },
        "timestamp": new Date()
    };
    return Object.assign({}, statement);
}

function cloneInitStatement() {
    let statement = {
        "actor": {
            "name": "",
            "objectType": "Agent",
            "account": {
                "homePage" : "",
                "name": ""
            }
        },
        "verb": {
            "id": "",
            "display": {"en-US": ""}
        },
        "object": {
            "id": "",
            "definition": {
                "name": {"en-US": ""},
                "description": {"en-US": ""},
                "type": "http://adlnet.gov/expapi/activities/attempt"
            }
        },
        "context": {
            "platform": "",
            "contextActivities": {
                "category" : [
                ],
                "parent" : [
                ],
                "grouping" : [
                ]
            }
        },
        "timestamp": new Date()
    };
    return Object.assign({}, statement);
}