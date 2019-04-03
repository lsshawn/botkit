var Botkit = require(__dirname + '/CoreBot.js');
var WebSocket = require('ws');
const Redis = require('ioredis')
const mongoose = require('mongoose')
const redis = new Redis(6379)
const pub = new Redis()

/*
 * convert string to template string
 * e.g. 'I am a ${SEX}' becomes 'I am a boy' if SEX variable exists
 */
const templateString = (tpl, args, defaultArgs, andOr) => {
    let replaceVar = (item) => {
        return item.replace(/\${(\w+)}/g, (_, v) => {
            let replaceValues
            if (args[v] === undefined || args[v].length === 0) {
                if (defaultArgs[v] === undefined || defaultArgs[v].length === 0) {
                    return ''
                } else {
                    replaceValues = defaultArgs[v]
                }
            } else {
                replaceValues = args[v]
            }
            if (typeof replaceValues === 'object' & Object.keys(replaceValues).length > 1) {
                const a = replaceValues
                return a.slice(0, a.length - 1).join(', ') + ' ' + andOr[v] + ' ' + a[a.length - 1]
            } else {
                return replaceValues
            }
        })
    }

    if (Array.isArray(tpl)) {
        // skip json
        return tpl.map((obj) => {
            return typeof obj === 'object' ? obj : replaceVar(obj)
        })
    } else {
        return tpl
    }
}

const getParamsJson = (params) => {
    let query = params
    if (query.startsWith('/?')) {
        query = query.substring(2)
    }
    let result = {}
    query.split('&').forEach((part) => {
        var item = part.split('=')
        result[item[0]] = decodeURIComponent(item[1])
    })
    return result
}

/*
 * helper function to loop through userIDs in 'channelIds/user1/user2/...
 * and publish to everyone except self.
 */
const publishToUsers = (message) => {
    let users = message.channel.split('/')
    users.shift() // remove channel ID
    users.forEach((userId) => {
        // publish except to self
        if (userId !== message.to) {
            console.log('publishing to: ', userId)
            pub.publish(userId, JSON.stringify(message))
        }
    })
}

function WebBot(configuration) {

    var controller = Botkit(configuration || {});

    controller.excludeFromConversations(['reconnect']);

    controller.openSocketServer = function (server) {

        // create the socket server along side the existing webserver.
        var wss = new WebSocket.Server({
            server
        });

        // Expose the web socket server object to the controller so it can be used later.
        controller.wss = wss;

        function heartbeat() {
            this.isAlive = true;
        }

        let users = []

        redis.on('message', function (channel, message) {
            /*
             * console.log('Receive message %s from channel %s', message, channel)
             * console.log('Channel readystate', users[channel].readyState)
             */
            if (users[channel] && users[channel].readyState === 1) {
                users[channel].send(message)
            }
        })

        wss.on('connection', async function connection(ws, req) {
            const params = getParamsJson(req.url)
            redis.subscribe(params.user, function (err, count) {
                console.log(`Subscribed to ${ params.user }`)
                console.log('total subscription: ', count)
            })

            // console.log('connection: ', params)

            if (!users.includes(params.user)) {
                users[params.user] = ws
            }

            ws.isAlive = true;
            ws.on('pong', heartbeat);
            // search through all the convos, if a bot matches, update its ws

            let botConfigs = null
            let cupbotsId
            // check if params.to is a valid mongoose ID to prevent crashes
            const valid = mongoose.Types.ObjectId.isValid(params.to)
            if (!valid) {
                console.log(`Params.to is not a valid mongoose ID. ${ params.to }`)
            } else {
                botConfigs = await controller.getUserConfig(params.to)
                // For Facebook bot, it's in incoming_webhooks.js
                if (botConfigs) {
                    cupbotsId = botConfigs._id
                    /*
                     * flatten the array of config k/v in each bot to turn it into an object
                     * so I can use dot notation in my bot skill
                     */
                    botConfigs = botConfigs.configs.reduce((obj, item) => {
                        let andOr = []
                        if (item.configKeys) {
                            item.valuesKV = item.configKeys.reduce((a, k) => {
                                a[k.key] = k.values || ''
                                return a
                            }, {})

                            andOr = item.configKeys.reduce((a, k) => {
                                a[k.key] = k.andOr || ''
                                return a
                            }, {})

                            item.defaultValuesKV = item.configKeys.reduce((a, k) => {
                                a[k.key] = k.defaultValues || []
                                return a
                            }, {})
                        }

                        if (item.replies) {
                            item.repliesKV = item.replies.reduce((a, k) => {
                                a[k.key] = k.replies || []
                                return a
                            }, {})

                            item.defaultRepliesKV = item.replies.reduce((a, k) => {
                                a[k.key] = k.defaultReplies || []
                                return a
                            }, {})

                            item.defaultNoneRepliesKV = item.replies.reduce((a, k) => {
                                a[k.key] = k.defaultNoneReplies || []
                                return a
                            }, {})

                            item.noneRepliesKV = item.replies.reduce((a, k) => {
                                a[k.key] = k.noneRepliesKV || []
                                return a
                            }, {})
                        }

                        /*
                         * replace ${} in default_template with variables in answers
                         * https://jsfiddle.net/lss/78j6fy6q/
                         */
                        if (item.valuesKV && Object.keys(item.valuesKV).length !== 0) {
                            const flds = ['repliesKV', 'defaultRepliesKV', 'noneRepliesKV', 'defaultNoneRepliesKV']

                            for (let i = 0; i < flds.length; i++) {
                                let fld = flds[i]
                                if (Object.keys(item[fld]).length > 0) {
                                    item[fld] = Object.assign(...Object.entries(item[fld]).map(
                                        ([k, v]) => ({
                                            [k]: v.map((keyVal) => {
                                                return Object.assign(...Object.entries(keyVal).map(
                                                    ([innerK, innerV]) => ({
                                                        [innerK]: templateString(innerV, item.valuesKV, item.defaultValuesKV, andOr)
                                                    })
                                                ))
                                            })
                                        })
                                    ))
                                }
                            }
                        }

                        if (['Broadcast', 'Event'].includes(item.type)) {
                            obj[item.id] = item
                        } else {
                            if (!item.defaultConfig || !item.defaultConfig.id) {
                                console.log(`No defaultConfig or defaultConfig.id field for bot ${ item._id }`)
                            } else {
                                obj[item.defaultConfig.id] = item
                            }
                        }
                        return obj
                    }, {})
                }
            }

            let bot

            if (botConfigs) {
                bot = controller.spawn(botConfigs);
                bot.cupbotsId = cupbotsId
                // console.log('bot: ',bot.botkit.events.message_received)
            } else {
                console.log('no botConfigs found for user')
                return
                // bot = controller.spawn();
            }

            bot.ws = ws;
            bot.connected = true;

            ws.on('message', function incoming(message) {
                try {
                    var message = JSON.parse(message);
                    // only push certain commands to other party
                    if (message.type === 'command' && message.text) {
                        let txt = message.text.split([' '])
                        const cmd = txt[0]
                        if (cmd === '/pausebot') {
                            pub.publish(message.to, JSON.stringify(message))
                        }
                    } else {
                        pub.publish(message.to, JSON.stringify(message))
                    }
                    console.log('ws.on message: ', message)

                    const botMsg = message.to === message.from
                    if (!botMsg) {
                        controller.ingest(bot, message, ws)
                    }
                } catch (e) {
                    var alert = [
                        `Error parsing incoming message from websocket.`,
                        `Message must be JSON, and should be in the format documented here:`,
                        `https://botkit.ai/docs/readme-web.html#message-objects`
                    ];
                    console.error(alert.join('\n'));
                    console.error(e);
                    ws.send(alert.join('\n'));
                }

            });

            ws.on('error', (err) => console.error('Websocket Error: ', err));

            ws.on('close', function (err) {
                console.log('websocket close')
                bot.connected = false;
            });

        });

        var interval = setInterval(function ping() {
            wss.clients.forEach(function each(ws) {
                if (ws.isAlive === false) {
                    console.log('terminating ws: ', ws)
                    return ws.terminate();
                }
                //  if (ws.isAlive === false) return ws.terminate()
                ws.isAlive = false;
                ws.ping('', false, true);
            });
        }, 30000);

    };


    controller.middleware.ingest.use(function (bot, message, reply_channel, next) {

        /*
         * this could be a message from the WebSocket
         * or it might be coming from a webhook.
         * configure the bot appropriately so the reply goes to the right place!
         */
        if (!bot.ws) {
            bot.http_response = reply_channel;
        }

        /*
         * look for an existing conversation for this user/channel combo
         * why not just pass in message? because we only care if there is a conversation  ongoing
         * and we might be dealing with "silent" message that would not otherwise match a conversation
         */
        bot.findConversation({
            user: message.user,
            channel: message.channel
        }, function (convo) {
            if (convo) {
                if (bot.ws) {
                    // replace the websocket connection
                    convo.task.bot.ws = bot.ws;
                    convo.task.bot.connected = true;
                    // console.log('message type: ', message.type)
                    if (message.type == 'hello' || message.type == 'welcome_back') {
                        message.type = 'reconnect';
                    }
                } else {

                    /*
                     * replace the reply channel in the active conversation
                     * this is the one that gets used to send the actual reply
                     */
                    convo.task.bot.http_response = bot.http_response;
                }
            }
            next();
        });
    });

    controller.middleware.categorize.use(function (bot, message, next) {

        if (message.type == 'message') {
            message.type = 'message_received';
        }

        next();

    });

    controller.middleware.format.use(function (bot, message, platform_message, next) {

        if (!message.sent_timestamp) {
            message.sent_timestamp = new Date().getTime()
        }

        for (var key in message) {
            platform_message[key] = message[key];
        }
        /*
         * change channel into channelID only
         * platform_message.channel = platform_message.channel.split('/')[0]
         */

        if (!platform_message.type) {
            platform_message.type = 'message';
        }
        // console.log('format platform_message: ', platform_message)
        next();

    });


    controller.defineBot(function (botkit, config) {
        var bot = {
            type: 'socket',
            botkit: botkit,
            config: config || {},
            utterances: botkit.utterances,
        };

        bot.startConversation = function (message, cb) {
            botkit.startConversation(this, message, cb);
        };

        bot.createConversation = function (message, cb) {
            botkit.createConversation(this, message, cb);
        };

        bot.send = function (message, cb) {
            // console.log('bot.send: ', message)
            publishToUsers(message)
            if (bot.connected || !bot.ws) {
                if (bot.ws) {
                    try {
                        if (bot.ws && bot.ws.readyState === WebSocket.OPEN) {
                            bot.ws.send(JSON.stringify(message), function (err) {
                                if (cb) {
                                    return cb(err, message);
                                }
                            });
                        } else {
                            console.error('Cannot send message to closed socket');
                        }
                    } catch (err) {
                        return cb(err);
                    }
                } else {
                    try {
                        bot.http_response.json(message);
                        if (cb) {
                            cb(null, message);
                        }
                    } catch (err) {
                        if (cb) {
                            return cb(err, message);
                        } else {
                            console.error('ERROR SENDING', err);
                        }
                    }
                }
            } else {
                setTimeout(function () {
                    bot.send(message, cb);
                }, 3000);
            }
        };

        bot.startTyping = function () {
            if (bot.connected) {
                try {
                    if (bot.ws && bot.ws.readyState === WebSocket.OPEN) {
                        bot.ws.send(JSON.stringify({
                            type: 'typing'
                        }), function (err) {
                            if (err) {
                                console.error('startTyping failed: ' + err.message);
                            }
                        });
                    } else {
                        console.error('Socket closed! Cannot send message');
                    }
                } catch (err) {
                    console.error('startTyping failed: ', err);
                }
            }
        };

        bot.typingDelay = function (message) {

            return new Promise(function (resolve) {
                var typingLength = 0;
                if (message.typingDelay) {
                    typingLength = message.typingDelay;
                } else {
                    var textLength;
                    if (message.text) {
                        textLength = message.text.length;
                    } else {
                        textLength = 80; //default attachment text length
                    }

                    var avgWPM = 150;
                    var avgCPM = avgWPM * 7;

                    typingLength = Math.min(Math.floor(textLength / (avgCPM / 60)) * 1000, 2000);
                }

                setTimeout(function () {
                    resolve();
                }, typingLength);
            });

        };

        bot.replyWithTyping = function (src, resp, cb) {

            bot.startTyping();
            bot.typingDelay(resp).then(function () {

                if (typeof (resp) == 'string') {
                    resp = {
                        text: resp
                    };
                }

                resp.user = src.user;
                resp.channel = src.channel;
                resp.to = src.user;

                bot.say(resp, cb);
            });
        };


        bot.reply = function (src, resp, cb) {

            if (typeof (resp) == 'string') {
                resp = {
                    text: resp
                };
            }

            resp.user = src.user;
            resp.channel = src.channel;
            resp.to = src.user;

            if (resp.typing || resp.typingDelay || controller.config.replyWithTyping) {
                bot.replyWithTyping(src, resp, cb);
            } else {
                bot.say(resp, cb);
            }
        };

        bot.findConversation = function (message, cb) {
            botkit.debug('CUSTOM FIND CONVO', message.user, message.channel);
            for (var t = 0; t < botkit.tasks.length; t++) {
                for (var c = 0; c < botkit.tasks[t].convos.length; c++) {
                    if (
                        botkit.tasks[t].convos[c].isActive() &&
                        botkit.tasks[t].convos[c].source_message.user == message.user &&
                        botkit.excludedEvents.indexOf(message.type) == -1 // this type of message should not be included
                    ) {
                        botkit.debug('FOUND EXISTING CONVO!');
                        cb(botkit.tasks[t].convos[c]);
                        return;
                    }
                }
            }

            cb();
        };


        /*
         * return info about the specific instance of this bot
         * including identity information, and any other info that is relevant
         */
        bot.getInstanceInfo = function (cb) {

            return new Promise(function (resolve) {
                var instance = {
                    identity: {},
                    team: {},
                };

                if (bot.identity) {
                    instance.identity.name = bot.identity.name;
                    instance.identity.id = bot.identity.id;

                    instance.team.name = bot.identity.name;
                    instance.team.url = bot.identity.root_url;
                    instance.team.id = bot.identity.name;

                } else {
                    instance.identity.name = 'Botkit Web';
                    instance.identity.id = 'web';
                }

                if (cb) cb(null, instance);
                resolve(instance);

            });
        };

        bot.getMessageUser = function (message, cb) {
            return new Promise(function (resolve) {
                // normalize this into what botkit wants to see
                controller.storage.users.get(message.user, function (err, user) {

                    if (!user) {
                        user = {
                            id: message.user,
                            name: 'Unknown',
                            attributes: {},
                        };
                    }

                    var profile = {
                        id: user.id,
                        username: user.name,
                        first_name: user.attributes.first_name || '',
                        last_name: user.attributes.last_name || '',
                        full_name: user.attributes.full_name || '',
                        email: user.attributes.email, // may be blank
                        gender: user.attributes.gender, // no source for this info
                        timezone_offset: user.attributes.timezone_offset,
                        timezone: user.attributes.timezone,
                    };

                    if (cb) {
                        cb(null, profile);
                    }
                    resolve(profile);
                });
            });

        };


        return bot;
    });

    controller.handleWebhookPayload = function (req, res) {
        var payload = req.body;
        controller.ingest(controller.spawn({}), payload, res);
    };

    // Substantially shorten the delay for processing messages in conversations
    controller.setTickDelay(10);
    return controller;
}

module.exports = WebBot;
