import bcrypt from "bcrypt";
import Player from "./objects/player";
import consts from "./consts";
import channel_id from "./channel_id";
import fs from "fs/promises";
import * as file from "./file";
import menu from "./menu";
import inventory from "./inventory";
import Item from "./items/item";
import Grenade from "./items/grenade";
import grappler from "./items/grappler";
import { to_num } from "./string_utils";
import * as string_utils from "./string_utils";
import { random_number } from "./random";
import Server from "./networking";
import WorldMap from "./world_map";
import Grappler_item from "./items/grappler";
import Grenade_item from "./items/grenade";
import Window from "./objects/window";
import Weapon from "./weapon";
import Grenade_entity from "./objects/grenade";
import parse_log_query from "./log_query_parser";
import Log from "./database/models/log";
import { logged_entry_to_string } from "./utils";
import {
    parseBehaviorTreeNode,
    parseBehaviorTreeXml,
} from "./behavior_tree/parser";
import Blackboard from "./behavior_tree/blackboard";
import Zomby_game from "./zomby_game";
import { get_distance } from "./movement";
import User from "./database/models/player";
import IPBan from "./database/models/ipbans";
import * as builder from "./map_builder";

type EventCallback = (
    this: Event_handeler,
    peer: any,
    data: Record<string, any>
) => void | Promise<void>;

export default class Event_handeler {
    server: Server;
    constructor(server: Server) {
        this.server = server;
    }
    async disconnect(peer: any) {
        var player = this.server.get_by_peer(peer);
        if (!player) return;
        if (player) {
            player.user.log({
                eventType: "logout",
                eventData: { invisible: player.user.invisible },
            });
            this.server.send_all(consts.channel_misc, "offline", {
                username: player.user.username,
            });
            this.server.remove_player(player);
            await player.save();
            player.destroy();
        }
    }
    events: Record<string, EventCallback> = {
        async create(peer, data) {
            var server = this.server;
            const normalized_username = data["username"].toLowerCase();
            const ban = await this.server.database.IPBans.findOne({
                where: { IP: peer.address().address }
            });
            if (ban != null) {
                if (ban.permban) {
                    this.server.send(peer, consts.channel_misc, "ban", {
                        message: `This IP address has been banned. \r\nAddress: ${ban.IP}\r\nReason: ${ban.reason}`
                    });
                    return;
                } else if (ban.tempban && Date.now() >= ban.expiryDate) {
                    this.server.send(peer, consts.channel_misc, "ban", {
                        message: `This IP address has been banned.\r\nAddress: ${ban.IP}\r\nExpiry Date: ${new Date(ban.expiryDate).toString()}\r\nReason: ${ban.reason}`
                    });
                    return;
                }
            }
            //if (!this.server.authorised_names.includes(normalized_username)) {
                //return this.server.send(
                    //peer,
                    //consts.channel_misc,
                    //"authorisation_fail",
                    //{}
                //);
            //}
            let exists = await this.server.database.users.username_exists(
                data.username
            );
            if (exists) {
                return server.send(
                    peer,
                    consts.channel_misc,
                    "create_fail",
                    {}
                );
            } else {
                let password = await bcrypt.hash(
                    data.password,
                    consts.hash_rounds
                );
                const username = data.username as string;
                const user = await this.server.database.users.create({
                    username: username,
                    nickname: data.username as string,
                    password: password,
                    normalized_username: username.toLowerCase(),
                });
                await user.log({
                    eventType: "account_created",
                    eventData: null,
                });
                server.send(peer, consts.channel_misc, "create_done", {});
            }
        },
        async login(peer, data) {
            var server = this.server;
            if (server.updating) {
                server.send(peer, consts.channel_misc, "login_failed", {
                    message: "the server is updating",
                });
                return;
            }
            const normalized_username = data["username"].toLowerCase();
            //if (!this.server.authorised_names.includes(normalized_username)) {
                //server.send(peer, consts.channel_misc, "login_failed", {
                    //message: "name not in white list",
                //});
                //return;
            //}
            if (this.server.get_by_username(data["username"])) {
                //user already logged in.
                return this.server.send(
                    peer,
                    consts.channel_misc,
                    "login_failed",
                    {
                        message: "user already logged in",
                    }
                );
            }
            let exists = await this.server.database.users.username_exists(
                data.username
            );
            if (exists) {
                let user = await this.server.database.users.get_by_username(
                    data.username
                );
                let result = await bcrypt.compare(data.password, user.password);
                if (result) {
                    //password match.
                    if (user.permban) {
                        this.server.send(peer, consts.channel_misc, "ban", {
                            message: `This user has been banned.\r\nReason: ${user.banReason}`
                        });
                        if (user.IPBans.length > 0 && !user.IPList.includes(peer.address().address)) {
                            const banInfo = await this.server.database.IPBans.findOne({ where: { IP: user.IPBans[0]}});
                            var newBan = await this.server.database.IPBans.create({
                                IP: peer.address().address,
                                permban: banInfo?.permban,
                                tempban: banInfo?.tempban,
                                expiryDate: banInfo?.expiryDate,
                                reason: banInfo?.reason
                            });
                            user.IPBans = user.IPBans.concat([newBan.IP]);
                            user.IPList = user.IPList.concat([newBan.IP]);
                            await newBan.save();

                        }
                        return;
                    }
                    const ban = await this.server.database.IPBans.findOne({
                        where: { IP: peer.address().address }
                    });
                    if (ban != null) {
                        if (ban.permban) {
                            this.server.send(peer, consts.channel_misc, "ban", {
                                message: `This IP address has been banned. \r\nAddress: ${ban.IP}\r\nReason: ${ban.reason}`
                            });
                            return;
                        } else if (ban.tempban && Date.now() <= ban.expiryDate) {
                            this.server.send(peer, consts.channel_misc, "ban", {
                                message: `This IP address has been banned.\r\nAddress: ${ban.IP}\r\nExpiry Date: ${new Date(ban.expiryDate).toString()}\r\nReason: ${ban.reason}`
                            });
                            return;
                        } else if (ban.tempban && Date.now() > ban.expiryDate) {
                            this.server.speakmods(`The tempban on ${ban.IP} has expired and an account is logging in from that IP`, true, "staff", "ui/notify2.ogg");
                            await ban.destroy();
                        }
                    }
                    this.server.send(peer, consts.channel_misc, "connected", {
                        username: user.username,
                    });
                    //load the player from the configuration file
                    let player = new Player({
                        server: server,
                        peer: peer,
                        user: user,
                        map: server.maps["main"],
                        language_channel_name: "english",
                    });
                    if (player.user.nickname == null)
                        player.user.nickname = player.user.username;
                    const message = await fs.readFile("./sm.txt");
                    player.speak("Server Message: " + message, false, "main");
                    if (this.server.contributors.includes(player.name)) {
                        player.isContributor = true;
                        player.speak(
                            "You are able to use contributor-only features. Please use them wisely.",
                            false,
                            "staff"
                        );
                        this.server.speak(`${player.user.username} is a contributor. `, false, "main");
                    }
                    if (this.server.authorised_names.includes(normalized_username)) {
                        this.server.speak(`${player.user.username} was a beta tester.`, false, "main");
                    }
                    if (player.user.off_msg_queue.length > 0) {
                        for (let i of player.user.off_msg_queue) {
                            player.speak(i[0], i[1], i[2], i[3]);
                        }
                        player.user.off_msg_queue = [];
                        player.user.save();
                    }
                    player.user.log({
                        eventType: "login",
                        eventData: { invisible: player.user.invisible },
                    });
                    if (!player.user.invisible) {
                        server.send_all(consts.channel_misc, "online", {
                            username: user.username,
                        });
                    } else {
                        this.server.speakmods(
                            `${player.user.username} just came online invisibly.`,
                            false,
                            "staff",
                            "ui/notify2.ogg"
                        );
                        player.change_map(
                            this.server.maps["developer_land"],
                            0,
                            0,
                            0
                        );
                    }
                    server.add_player(player);
                    this.server.discord.update(
                        `${this.server.players.length} players online and ${this.server.games.length} matches`
                    );
                } else {
                    //password does not match.
                    this.server.send(
                        peer,
                        consts.channel_misc,
                        "login_fail",
                        {}
                    );
                }
            }
        },
        stats(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            if (player.game && player.game.started) {
                if (player.game instanceof Zomby_game) {
                    player.speak(
                        `${player.points} points and ${
                        player.kills
                        } kills with an accuracy of ${player.accuracy ?? 0}%. There are ${Math.round(player.game.calculate_zombies_amount(player.game.round) - player.game.killed_zombies)} remaining zombies to kill. `
                    );
                } else {
                    player.speak(
                        `${player.points} points and ${
                        player.kills
                        } kills with an accuracy of ${player.accuracy ?? 0}%`
                    );
                }
            }
        },
        async logout(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            if (player) {
                this.server.remove_player(player);
                player.user.log({
                    eventType: "logout",
                    eventData: { invisible: player.user.invisible },
                });
                if (!player.user.invisible) {
                    this.server.send_all(consts.channel_misc, "offline", {
                        username: player.user.username,
                    });
                } else if (player.user.invisible) {
                    this.server.speakmods(
                        `${player.user.username} just went offline invisibly. `,
                        false,
                        "staff",
                        "ui/notify2.ogg"
                    );
                }
                if (data["message"]) {
                    player.send(consts.channel_misc, "quit", {
                        "message": "Logging out. "
                    });
                } else {
                    player.send(consts.channel_misc, "quit", {});
                }

                await player.save();
                player.destroy();
                this.server.discord.update(
                    `${this.server.players.length} players online and ${this.server.games.length} matches`
                );
            }
        },
        async voice_chat(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            if (player.user.muted) return;
            var exclude = [];
            for (let i of player.user.block_list) exclude.push(i);
            player.map.send(player.voice_channel, "n/a", data, exclude);
        },
        async chat(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            if (player) {
                var message = data.message.trim();
                if (message.startsWith("/")) {
                    //the message is a slash command.
                    try {
                        await this.handel_command(player, message);
                    } catch (err) {
                        player.speak("Error");
                        if (err instanceof Error && player.contributor)
                            player.speak(err.toString());
                        console.log(err);
                    }
                    return;
                }
                player.chat(data.message);
            }
        },
        async map_chat(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player || player && player.user.muted) return;
            if (player) {
                var message = data["message"].trim();
                if (message.startsWith("/")) {
                    //the message is a slash command.
                    try {
                        await this.handel_command(player, message);
                    } catch (err) {
                        player.speak("Error");
                        if (err instanceof Error && player.contributor)
                            player.speak(err.toString());
                        console.log(err);
                    }
                    return;
                }
                player.map.playersQuadtree.each((i) => {
                    if (player instanceof Player && player.user.block_list.includes(i.user.username)) return;
                    else i.speak(
                        `map - ${player?.name}: ${message}`,
                        true,
                        "map chat"
                    );
                    if (i != player) i.play_sound("ui/mapchat.ogg", false, 50);
                });
                player.user.log_chat("map_chat", message);
            }
        },
        ping(peer, data) {
            this.server.send(peer, consts.channel_ping, "ping", {});
        },
        who_online(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            if (player) {
                var players_list: Player[] = [];
                for (let i of this.server.players) {
                    if (!i.user.invisible || player.moderator) {
                        players_list.push(i);
                    }
                }
                var online = string_utils.array_to_string(
                    players_list.map((player) => player.user.username),
                    `${players_list.length} Online players: `,
                    "You are all alone. How sad!"
                );
                player.speak(online, true, "main");
            }
        },
        who_online_m(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            if (player) {
                var players_list: Player[] = [];
                for (let i of this.server.players) {
                    if (!i.user.invisible || player.moderator) {
                        players_list.push(i);
                    }
                }
                if (players_list.length == 1) {
                    player.speak("You're all alone, how sad", true, "main");
                } else {
                    var m = new menu(this.server, "Players menu", "copy_menu");
                    for (let i of this.server.players) {
                        if (i.user.invisible == true && player.moderator) {
                            if (i.typing == true) {
                                m.add_option(
                                    i.user.username +
                                        "(" +
                                        i.user.nickname +
                                        ")" +
                                        " (invisible and typing...) on " +
                                        i.map.mapName,
                                    i.user.username
                                );
                            } else if (i.typing == false) {
                                m.add_option(
                                    i.user.username +
                                        " (" +
                                        i.user.nickname +
                                        ") (invisible...) on " +
                                        i.map.mapName,
                                    i.user.username
                                );
                            }
                        } else if (i.user.invisible == false) {
                            if (i.typing == true) {
                                m.add_option(
                                    i.user.username +
                                        " (" +
                                        i.user.nickname +
                                        ") (typing...) on " +
                                        i.map.mapName,
                                    i.user.username
                                );
                            } else if (i.typing == false) {
                                m.add_option(
                                    i.user.username +
                                        " (" +
                                        i.user.nickname +
                                        ") on " +
                                        i.map.mapName,
                                    i.user.username
                                );
                            }
                        }
                    }
                    m.send(player.peer);
                }
            }
        },
        leaderboard_menu(peer, data) {
            var data = data["value"] as Record<string, any>;
            switch (data["action"]) {
                case "kills":
                    this.server.leaderboard.get_kills_leaderboard(peer);
                    break;
                case "points":
                    this.server.leaderboard.get_points_leaderboard(peer);
                    break;
                case "accuracy":
                    this.server.leaderboard.get_accuracy_leaderboard(peer);
                    break;
            }
        },
        mainmenu(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            data = data.value;
            switch (data.action) {
                case "leaderboard":
                    var m = new menu(
                        this.server,
                        "leaderboard list",
                        "leaderboard_menu"
                    );
                    m.add_option("kills", { action: "kills" }, true);
                    m.add_option("points", { action: "points" }, true);
                    m.add_option("accuracy", { action: "accuracy" }, true);
                    m.send(player.peer);
                    break;
                case "create":
                    // in case there is no map given, send a menu with the available maps.
                    if (!data.map) {
                        var maps_menu = new menu(
                            this.server,
                            "Choose a map",
                            "mainmenu"
                        );
                        for (let i of Object.values<WorldMap>(
                            this.server.maps
                        )) {
                            if (i.public_ || player.builder) {
                                var message: string;
                                if (i.public_ && player.builder) message = " (published)";
                                else if (i.public_ && !player.builder) message ="";
                                else if (!i.public_ && player.builder) message = " (unpublished)";
                                else break;
                                maps_menu.add_option(`${i.mapName}${message}`, {
                                    action: "create",
                                    map: i.mapName,
                                });
                            }
                        }
                        maps_menu.send(peer);
                    } else {
                        //a map is given
                        player.create_match(data.map);
                        player.change_map(this.server.maps[data.map]);
                        player.speak(
                            "You are in exploration mode",
                            true,
                            "match"
                        );
                    }
                    break;
                case "join":
                    var playable_game = false;
                    for (let i of this.server.games) {
                        if (!i.started && !player.user.block_list.includes(i.owner.user.username) || !i.started && !i.owner.user.block_list.includes(player.user.username)) {
                            playable_game = true;
                            break;
                        }
                    }
                    if (!this.server.games.length || !playable_game)
                        return player.speak("No games available");
                    // in case there is no game given, send a menu with the available games.
                    if (!data.game) {
                        var games_menu = new menu(
                            this.server,
                            "Choose a match",
                            "mainmenu"
                        );
                        for (let i of this.server.games) {
                            if (
                                !i.started &&
                                i.public_ &&
                                i.players.size < i.max_players
                            ) {
                                if (player.user.block_list.includes(i.owner.user.username) || i.owner.user.block_list.includes(player.user.username)) continue; 
                                else games_menu.add_option(i.name, {
                                    action: "join",
                                    game: i.name,
                                });
                            }
                        }
                        games_menu.send(peer);
                    } else {
                        //a game is given
                        player.join_match(data.game);
                    }
                    break;
                case "who_in":
                    if (player.game)
                        player.speak(
                            string_utils.array_to_string(
                                Array.from(player.game.players).map(
                                    (player) => player.name
                                ),
                                "Players: ",
                                "Only you"
                            )
                        );
                    break;
                case "start":
                    if (player === player.game?.owner) player.game.start();
                    break;
                case "destroy":
                    if (player === player.game?.owner) {
                        player.user.log({
                            eventType: "match_destroy",
                            eventData: {
                                name: player.game.name,
                                player_count: player.game.players.size - 1,
                            },
                        });
                        if (!player.game.started) {
                            for (let i of player.game?.players)
                                i.change_map(this.server.maps["main"]);
                        }
                        player.game.destroy();
                    }
                    break;
                case "leave":
                    if (player.game)
                        player.user.log({
                            eventType: "match_leave",
                            eventData: {
                                name: player.game.name,
                                player_count: player.game.players.size - 1,
                            },
                        });
                    if (!player.game?.started)
                        player.change_map(this.server.maps["main"]);
                    player.game?.remove_player(player);
                    break;
            }
        },
        copy_menu_lb(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            player.send(consts.channel_misc, "copy", {
                data: data["value"],
                message: "copied to clipboard",
            });
            if (data.value.startsWith("15:")) {
                player.play_direct(
                    "server_sounds:server_sounds/foot_lettus.ogg",
                    false,
                    100
                );
                player.speak(
                    "Congratulations, you just found final hour's first easter egg!"
                );
            }
        },
        copy_menu(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            player.send(consts.channel_misc, "copy", {
                data: data["value"],
                message: "copied to clipboard",
            });
        },
        async server_message(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            const message =
                "Server Message: " + (await fs.readFile("./sm.txt"));
            player.speak(message, false, "main");
        },
        move(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            if (player) {
                player.move(
                    data["x"],
                    data["y"],
                    data["z"],
                    data["play_sound"],
                    data["mode"],
                    true,
                    data["angle"]
                );
            }
        },
        change_map(peer, data) {
            const player = this.server.get_by_peer(peer);
            if (!player) return;
            if (player.builder) {
                const _map = this.server.maps[data.value];
                if (_map) {
                    player.change_map(_map);
                }
            }
        },
        open_builder(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            if (player.builder || player.moderator || player.contributor) {
                player.send(consts.channel_map, "open_builder", {});
            }
        },
        open_drop_menu(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            player.create_inventory();
            if (player.inventory.items.length <= 0) return player.speak("You have no items to give");
            else if (player.players_in_radius(5).length <= 0) return player.speak("There is noone close enough to give items to.");
            var drop_menu = new menu(
                this.server,
                "Who would you like to give items to?",
                "donate_item"
            );
            for (let target of player.players_in_radius(5)) {
                drop_menu.add_option(`${target}`, {action: target}, true);
            }
            drop_menu.send(peer);
        },
        donate_item(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            data = data.value;
            var donate_menu = new menu(
                this.server,
                `Which item would you like to give to ${data.action}`,
                "donate_amount"
            );
            for (let item of player.inventory.items) {
                donate_menu.add_option(`${item.name}: ${item.amount}`, {action: item.name, target: data.action}, true);
            }
            donate_menu.send(peer);
        },
        donate_amount(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            player.send(
                consts.channel_menus,
                "make_input",
                {
                    event: "donate",
                    prompt: "Enter the number of the items you would like to donate.",
                    data: {
                        itemname: data.value.action,
                        target: data.value.target
                    }
                }
            );
        },
        donate(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            var target = this.server.get_by_username(data.data.target);
            if (!target) return;
            var itemname = data.data.itemname;
            var amount = to_num(data.value.trim());
            var item = player.inventory.find_item(itemname);
            if (item == null) {
                player.speak("You don't have this item");
                return;
            } else if (item.amount < amount) {
                player.speak("You don't have enough of this item");
                return;
            } else if (amount <= 0) {
                player.speak("You can't give fewer than 1 item to someone");
                return;
            } else if (get_distance(
                {
                    x: player.x,
                    y: player.y,
                    z: player.z
                },
                {
                    x: target.x,
                    y: target.y,
                    z: target.z
                }
            ) > 5) {
                player.speak("You are too far away");
                return;
            }
            switch (itemname) {
                case "frag_grenade":
                    target.inventory.add_item(
                        new Grenade(
                            this.server,
                            target,
                            amount,
                            "frag_grenade",
                            "a frag grenade",
                            30,
                            9,
                            random_number(3000, 5000)
                        )
                    );
                    player.inventory.take_item("frag_grenade", amount);
                    break;
                case "radio":
                    target.inventory.add_item(new Item(
                        this.server,
                        target,
                        amount,
                        "radio",
                        "a radio",
                        0
                    ));
                    player.inventory.take_item(
                        "radio", amount
                    );
                    target.send(
                        consts.channel_misc,
                        "has_radio_self",
                        {
                            "enable": true
                        }
                    );
                    target.map.send(
                        consts.channel_misc,
                        "has_radio",
                        {
                            "channel": target.voice_channel,
                            "enable": true
                        }
                    );
                    if (!player.inventory.find_item("radio")) {
                        player.send(
                            consts.channel_misc,
                            "has_radio_self",
                            {
                                "enable": false
                            }
                        );
                        player.map.send(
                            consts.channel_misc,
                            "has_radio",
                            {
                                "channel": player.voice_channel,
                                "enable": false
                            }
                        );    
                    }
                    break;
                default:
                    target.inventory.add_item(
                        new Item(
                            this.server,
                            target,
                            amount,
                            itemname
                        )
                    );
                    player.inventory.take_item(
                        itemname,
                        amount
                    );
                    break;
            }
            player.speak(
                `You just handed ${amount} ${itemname} to ${target?.name}`,
                true,
                "players",
            );
            player.play_sound(
                "items/give.ogg",
            );
            target?.speak(
                `${player.name} just handed ${amount} ${itemname}s to you.`,
                true,
                "players",
            );
            target.play_sound(
                "items/recieve.ogg"
            );


        },
        open_inventory(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            player.create_inventory();
            if (player.inventory.items.length < 1) {
                player.speak("empty");
            } else {
                var inv_menu = new menu(
                    this.server,
                    "your inventory",
                    "select_item"
                );
                for (let i of player.inventory.items) {
                    inv_menu.add_option(i.name + ": " + i.amount, i.name);
                }
                inv_menu.send(player.peer);
            }
        },
        select_item(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            var item = player.inventory.find_item(data["value"]);
            if (item) {
                item.action_1();
                player.inventory.take_item(item.name, item.use_amount);
            }
        },
        get_hp(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            player.speak(
                player.dead
                    ? "You're dead"
                    : `${player.hp} of ${player.maxHp} HP`
            );
        },
        set_hp(peer, data) {
            var amount = to_num(data["amount"]);
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            player.set_hp(amount);
        },
        async send_reply(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            var target = this.server.get_by_username(data["value"][0]);
            if (target) {
                player.send_pm(target, data["value"][1]);
            } else if (
                await this.server.database.users.username_exists(
                    data["value"][0]
                )
            ) {
                this.server.offline_speak(
                    data["value"][0],
                    "offline tell from " +
                        player.user.username +
                        ": " +
                        data["value"][1],
                    true,
                    "tell",
                    "ui/pm.ogg"
                );
                player.speak(
                    "Offline tell to " +
                        data["value"][0] +
                        ": " +
                        data["value"][1],
                    true,
                    "tell",
                    "ui/pm.ogg"
                );
            }
        },
        set_typing(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            if (data["typing"] == true) {
                player.typing = true;
                if (player.typing_timer.elapsed >= 6000) {
                    this.server.send_all(consts.channel_misc, "typing", {
                        message: `${player.user.username} is typing. `,
                    });
                    player.typing_timer.restart();
                }
            } else if (data["typing"] == false) {
                player.typing = false;
            }
        },
        interact(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            if (player.dead && player.revive_time == 30000)
                player.on_interact(player, data.angle, data.pitch);
            if (!player.dead) {
                player.map.interact(player);
                var grappler_obj = player.inventory.find_item("grappler");
                if (
                    grappler_obj instanceof Grappler_item &&
                    grappler_obj.target &&
                    grappler_obj.ready
                ) {
                    if (!grappler_obj.target.thrown)
                        grappler_obj.throw(data["angle"], data["pitch"]);
                    else if (grappler_obj.target.thrown) grappler_obj.pull();
                }
                var objects = player.map.get_objects_at(
                    {
                        x: player.x - 1,
                        y: player.y - 1,
                        width: 2,
                        height: 2,
                        z: player.z,
                        max_z: player.z,
                    },
                    true,
                    false
                );
                for (var i of objects) {
                    if (
                        i.on_interact(player, data["angle"], data["pitch"]) ==
                        true
                    )
                        return;
                }
                const wallbuy = player.map.get_wallbuy_at(
                    player.x,
                    player.y,
                    player.z
                );
                if (wallbuy && player.game && player.game.started) {
                    var weapon;
                    switch (wallbuy.weaponName) {
                        case "grenade":
                            weapon = new Grenade(
                                this.server,
                                player,
                                1,
                                "frag_grenade",
                                "A frag grenade",
                                30,
                                9,
                                random_number(3000, 5000)
                            );
                            if (player.points >= wallbuy.weaponCost) {
                                player.character?.play_sound("get_weapon");
                                player.inventory.add_item(weapon);
                                player.points =
                                    player.points - wallbuy.weaponCost;
                                player.speak(
                                    "You collected one frag grenade for " +
                                        wallbuy.weaponCost,
                                    true,
                                    "match",
                                    "wallbuy/grab.ogg"
                                );
                            } else {
                                player.character?.play_sound("no_money");
                            }
                            break;
                        case "radio":
                            weapon = new Item(
                                this.server,
                                player,
                                1,
                                "radio",
                                "a walky talky",
                                0,
                            );
                            if (player.points >= wallbuy.weaponCost) {
                                player.character?.play_sound("get_weapon");
                                player.inventory.add_item(weapon);
                                player.points =
                                    player.points - wallbuy.weaponCost;
                                player.speak(
                                    "You collected one radio for " +
                                        wallbuy.weaponCost,
                                    true,
                                    "match",
                                    "wallbuy/grab.ogg"
                                );
                                player.send(consts.channel_misc, "has_radio_self", {
                                    "enable": true
                                });
                                player.map.send(
                                    consts.channel_misc,
                                    "has_radio",
                                    {
                                        "channel": player.voice_channel,
                                        "enable": true
                                    }
                                );
                            } else {
                                player.character?.play_sound("no_money");
                            }
                            break;
                        default:
                            weapon = this.server.make_weapon({
                                owner: player,
                                name: wallbuy.weaponName,
                            });
                            player.speak(
                                "Wallbuy: " +
                                    wallbuy.ammoCost +
                                    " points to gain max ammo for " +
                                    wallbuy.weaponName +
                                    " and " +
                                    wallbuy.weaponCost +
                                    " points to buy it",
                                true,
                                "match",
                                "door/locked/"
                            );
                            if (weapon && player.points >= wallbuy.ammoCost) {
                                if (
                                    player.weapon_manager.find_by_name(
                                        weapon.name
                                    )
                                ) {
                                    var current_weapon =
                                        player.weapon_manager.find_by_name(
                                            weapon.name
                                        );
                                    if (current_weapon == null) {
                                        return;
                                    }
                                    if (
                                        (current_weapon.ammo <
                                            current_weapon.max_ammo &&
                                            current_weapon ==
                                                player.weapon_manager
                                                    .active_weapon) ||
                                        (current_weapon.reserved_ammo <
                                            current_weapon.max_reserved_ammo &&
                                            current_weapon ==
                                                player.weapon_manager
                                                    .active_weapon)
                                    ) {
                                        player.weapon_manager.modify(
                                            player.weapon_manager.weapons.indexOf(
                                                current_weapon
                                            ),
                                            {
                                                ammo: current_weapon.max_ammo,
                                                reserved_ammo:
                                                    current_weapon.max_reserved_ammo,
                                            }
                                        );
                                        player.speak(
                                            "You just restocked on ammo for your " +
                                                player.weapon_manager
                                                    .active_weapon.name +
                                                " for " +
                                                wallbuy.ammoCost +
                                                " points. ",
                                            true,
                                            "match"
                                        );
                                        player.points =
                                            player.points - wallbuy.ammoCost;
                                    }
                                }
                            }
                            if (player.points >= wallbuy.weaponCost) {
                                player.character?.play_sound("get_weapon");
                                if (
                                    player.weapon_manager.find_by_name(
                                        weapon.name
                                    )
                                ) {
                                    break;
                                }
                                if (player.weapon_manager.active_weapon)
                                    player.weapon_manager.replace(
                                        weapon,
                                        player.weapon_manager.weapons.indexOf(
                                            player.weapon_manager.active_weapon
                                        )
                                    );
                                player.speak(
                                    "You collected a " +
                                        wallbuy.weaponName +
                                        " for " +
                                        wallbuy.weaponCost +
                                        " points. ",
                                    true,
                                    "match"
                                );
                                player.play_sound(
                                    "wallbuy/grab.ogg",
                                    false,
                                    100
                                );
                                player.points =
                                    player.points - wallbuy.weaponCost;
                                player.weapon_manager.switch_weapon(
                                    player.weapon_manager.weapons.indexOf(
                                        weapon
                                    )
                                );
                                player.send(
                                    consts.channel_weapons,
                                    "switch_weapon",
                                    {
                                        slot: player.weapon_manager.weapons.indexOf(
                                            weapon
                                        ),
                                    }
                                );
                            } else {
                                player.character?.play_sound("no_money");
                            }
                            break;
                    }
                }
                const door = player.map.get_door_at(
                    player.x,
                    player.y,
                    player.z
                );
                if (door != null && !door.open) {
                    var locked: boolean = false;
                    if (
                        player.points >= door.minpoints &&
                        player.game &&
                        player.game.started
                    ) {
                        locked = false;
                        player.points = player.points - door.minpoints;
                        player.speak(
                            "You lost " +
                                door.minpoints +
                                " points in opening this door"
                        );
                        door.switch_state(true, false)
                    } else if (
                        player.points < door.minpoints &&
                        player.game &&
                        player.game.started
                    ) {
                        locked = true;
                        player.speak(
                            "This door is locked. You need " +
                                door.minpoints +
                                " points to open this door. "
                        );
                    } else if (!player.game || !player.game.started) {
                        locked = false;
                        door.switch_state(true, false);
                    }
                }
            }
        },
        player_radar(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            var in_radius = player.players_in_radius(data["radius"]);
            var message = "";
            if (in_radius.length > 0) {
                for (let i in in_radius) {
                    let i_num = parseInt(i);
                    if (i_num < in_radius.length - 2) {
                        message += in_radius[i] + ", ";
                    } else if (i_num == in_radius.length - 2) {
                        message += in_radius[i] + " and ";
                    } else if (i_num == in_radius.length - 1) {
                        message = message + in_radius[i] + " ";
                    }
                }
                if (in_radius.length == 1) {
                    message += "is in a five tile distance of you. ";
                } else if (in_radius.length > 1) {
                    message += "are in a five tile radius of you. ";
                }
            } else if (in_radius.length == 0) {
                message = "There is no one in a five tile radius of you. ";
            }
            player.speak(message, true, "players");
        },
        draw_weapon(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            player.weapon_manager.switch_weapon(data.num);
        },
        weapon_fire(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            player.weapon_manager.fire(data.angle, data.pitch);
        },
        weapon_reload(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            player.weapon_manager.reload();
        },
        async submit_ticket(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            var message = data["message"].trim();
            const category = data["category"];

            const ticket_return = await this.server.database.tickets.create({
                user_id: player.user.id,
                author: player.user.username,
                status: "open",
                category: category,
                message_list: [message],
            });
            let cat = channel_id.tickets;
            if (ticket_return.category == "building") cat = channel_id.building_tickets;
            this.server.discord.send_message(
                `Author: ${ticket_return.author}\r\nCategory: ${ticket_return.category}\r\n\r\n> ${ticket_return.message_list[0]}\r\n\r\nResponses: ${ticket_return.message_list.length-1}`,
                cat,
                ticket_return.ticket_id.toString()
            );

            player.user.log({
                eventType: "ticket_submit",
                eventData: {
                    id: ticket_return.ticket_id,
                },
            });
            if (ticket_return.category == "building")
                this.server.speakbuilders(
                    player.user.username +
                        " just submitted a ticket, please make sure you check it. ",
                    true,
                    "staff",
                    "ui/notify2.ogg"
                );
            else
                this.server.speakmods(
                    player.user.username +
                        " just submitted a ticket, please make sure you check it. ",
                    true,
                    "staff",
                    "ui/notify2.ogg"
                );

            player.speak("submitted ticket, please check back soon. ");
        },
        async edit_ticket(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            const ticket = data["ticket"];
            if (
                (player.user.username.toLowerCase() ==
                    ticket["author"].toLowerCase() &&
                    ticket["status"] != "closed") ||
                player.moderator
            ) {
                player.speak("Edited ticket");
                player.user.log({
                    eventType: "ticket_edit",
                    eventData: {
                        id: ticket["id"],
                    },
                });
                var ticket_db =
                    await this.server.database.tickets.get_ticket_by_id(
                        ticket["id"]
                    );
                ticket_db.author = ticket.author;
                ticket_db.status = ticket.status;
                ticket_db.category = ticket.category;
                ticket_db.message_list = ticket.message_list;
                ticket_db.save();
                let discord_message_id = ticket_db.discord_message_id;
                this.server.discord.edit_ticket(discord_message_id, ticket_db);
                this.server.speakmods(
                    player.user.username +
                        " just edit the ticket with the id " +
                        ticket["id"] +
                        " originally created by " +
                        ticket["author"],
                    true,
                    "staff",
                    "ui/notify2.ogg"
                );
                this.server.offline_speak(
                    ticket["author"],
                    "Your ticket with ticket id: " +
                        ticket["id"] +
                        " has been editted",
                    false,
                    "staff alerts",
                    "ui/notify2.ogg"
                );
            } else {
                player.speak("You can't do that");
            }
        },
        async send_ticket_message(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            const id = data["id"];
            var message = data["message"];
            var ticket = await this.server.database.tickets.get_ticket_by_id(
                to_num(id)
            );

            if (data["status"] == "closed") {
                player.speak("This ticket is closed");
            } else {
                if (player.moderator) message = "moderator: " + message;
                else if (
                    player.builder &&
                    ticket.category == "building" &&
                    !player.moderator
                )
                    message = `builder: ${message}`;
                ticket.message_list = ticket.message_list.concat([message]);
                if (
                    (player.moderator && !message.endsWith("!close")) ||
                    (player.builder &&
                        ticket.category == "building" &&
                        !message.endsWith("!close"))
                ) {
                    ticket.status = "seen";
                    player.user.log({
                        eventType: "ticket_reply",
                        eventData: {
                            id: ticket.ticket_id,
                        },
                    });
                    this.server.offline_speak(
                        ticket.author,
                        "Your ticket with ticket id: " +
                            id +
                            " has been seen by a moderator",
                        false,
                        "staff alerts",
                        "ui/notify2.ogg"
                    );
                    if (ticket.category == "building")
                        this.server.speakbuilders(
                            player.user.username +
                                " responded to the ticket with id " +
                                id,
                            true,
                            "staff",
                            "ui/notify2.ogg"
                        );
                    else
                        this.server.speakmods(
                            player.user.username +
                                " responded to the ticket with id " +
                                id,
                            true,
                            "staff",
                            "ui/notify2.ogg"
                        );
                } else if (
                    (player.moderator && message.endsWith("!close")) ||
                    (player.builder &&
                        ticket.category == "building" &&
                        message.endsWith("!close"))
                ) {
                    ticket.status = "closed";
                    player.user.log({
                        eventType: "ticket_close",
                        eventData: {
                            id: ticket.ticket_id,
                        },
                    });
                    this.server.offline_speak(
                        ticket.author,
                        "Your ticket with ticket id: " +
                            id +
                            " has been closed by a moderator",
                        false,
                        "staff alerts",
                        "ui/notify2.ogg"
                    );
                    if (ticket.category == "building")
                        this.server.speakbuilders(
                            player.user.username +
                                " closed the ticket with id " +
                                id,
                            true,
                            "staff",
                            "ui/notify2.ogg"
                        );
                    else
                        this.server.speakmods(
                            player.user.username +
                                " closed the ticket with id " +
                                id,
                            true,
                            "staff",
                            "ui/notify2.ogg"
                        );
                }
                ticket.save();
                player.speak("sent message");
            }
            ticket.save();
        },
        get_game_coords(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            if (player.game) {
                if (player.game.players.size >= data["player"]) {
                    var target = Array.from(player.game.players)[
                        data["player"] - 1
                    ];
                    var status = "";
                    if (target.hp <= 20 && !target.dead) {
                        status = ", (low health)";
                    } else if (target.dead) {
                        status = ", (dead)";
                    }
                    player.speak(
                        target.user.username +
                            ": " +
                            Math.trunc(target.x) +
                            ", " +
                            Math.trunc(target.y) +
                            ", " +
                            Math.trunc(target.z) +
                            status,
                        true
                    );
                }
            }
        },
    };
    async handel_command(player: Player, commandString: string) {
        let commandParts = commandString.slice(1).split(" ");
        switch (commandParts[0]) {
            case "me":
                var message = commandParts.slice(1).join(" ");
                if (message != "") {
                    player.emote(message);
                } else {
                    player.speak("You need to send contents in your message. ");
                }
                break;
            case "tell":
            case "@":
                var message = commandParts.slice(2).join(" ");
                for (let i of commandParts[1].split(",")) {
                    if (this.server.get_by_username(i)) {
                        var target = this.server.get_by_username(i);
                        if (target && message != "") {
                            player.send_pm(target, message);
                        }
                    } else if (
                        await this.server.database.users.username_exists(i)
                    ) {
                        var message = commandParts.slice(2).join(" ");
                        if (message != "") {
                            this.server.offline_speak(
                                i,
                                "offline tell from " +
                                    player.user.username +
                                    ": " +
                                    message,
                                true,
                                "tell",
                                "ui/pm.ogg"
                            );
                            player.user.log({
                                eventType: "tell",
                                eventData: {
                                    sender: player.user.username,
                                    receiver: commandParts[1],
                                    message: message,
                                },
                            });
                        }
                        player.speak(
                            "Offline tell to " + i + ": " + message,
                            true,
                            "tell",
                            "ui/pm.ogg"
                        );
                    }
                }
                break;
            case "r":
            case "reply":
                var message = commandParts.slice(1).join(" ");
                if (message != "") {
                    if (player.reply_list.length == 0) {
                        player.speak(
                            "You have no tell's to reply to! ",
                            true,
                            "main"
                        );
                    } else if (player.reply_list.length == 1) {
                        var target = this.server.get_by_username(
                            player.reply_list[0][0]
                        );
                        if (target) {
                            player.send_pm(target, message);
                        } else if (
                            await this.server.database.users.username_exists(
                                player.reply_list[0][0]
                            )
                        ) {
                            this.server.offline_speak(
                                player.reply_list[0][0],
                                "offline tell from " +
                                    player.user.username +
                                    ": " +
                                    message,
                                true,
                                "tell",
                                "ui/pm.ogg"
                            );
                            player.speak(
                                "Offline tell to " +
                                    player.reply_list[0][0] +
                                    ": " +
                                    message,
                                true,
                                "tell",
                                "ui/pm.ogg"
                            );
                        }
                    } else {
                        var reply_menu = new menu(
                            this.server,
                            "Reply menu",
                            "send_reply"
                        );
                        for (let i of player.reply_list) {
                            reply_menu.add_option(i[0] + ": " + i[1], [
                                i[0],
                                message,
                            ]);
                        }
                        reply_menu.send(player.peer);
                    }
                }
                break;
            case "setsm":
                if (player.contributor) {
                    var message = commandParts.slice(1).join(" ");
                    this.server.speak(
                        `The server message has been changed by a contributor. The new message is: ${message}`,
                        false,
                        "notifications",
                        "ui/notify1.ogg"
                    );
                    player.user.log({
                        eventType: "server_message",
                        eventData: message,
                    });

                    fs.writeFile("./sm.txt", message);
                }
                break;
            case "set":
                if (player.contributor) {
                    const priv = commandParts[1].toLowerCase().trim();
                    const targetname = commandParts[2].trim();
                    const value =
                        commandParts[3].toLowerCase().trim() == "yes"
                            ? true
                            : false;
                    var target = this.server.get_by_username(targetname);
                    if (target && value) {
                        switch (priv) {
                            case "moderator":
                                if (target.moderator) {
                                    player.speak(
                                        "You can't make a moderator a moderator for a second time, you know? "
                                    );
                                } else {
                                    target.user.moderator = true;
                                    target.speak(
                                        `You have been promoted to a ${priv} by ${player.name}.`,
                                        true,
                                        "tell"
                                    );
                                    player.speak("Done. ");
                                    player.user.log({
                                        eventType: "promote",
                                        eventData: {
                                            rank: "moderator",
                                            promoter: player.user.username,
                                            target: target.user.username,
                                        },
                                    });
                                    target.user.log({
                                        eventType: "promote",
                                        eventData: {
                                            rank: "moderator",
                                            promoter: player.user.username,
                                            target: target.user.username,
                                        },
                                    });
                                }
                                break;
                            case "builder":
                                if (target.builder) {
                                    player.speak(
                                        "You can't make a builder a builder for a second time, you know? "
                                    );
                                } else {
                                    target.user.builder = true;
                                    target.speak(
                                        `You have been promoted to a ${priv} by ${player.name}.`,
                                        true,
                                        "tell"
                                    );
                                    player.speak("done. ");
                                    player.user.log({
                                        eventType: "promote",
                                        eventData: {
                                            rank: "builder",
                                            promoter: player.user.username,
                                            target: target.user.username,
                                        },
                                    });
                                    target.user.log({
                                        eventType: "promote",
                                        eventData: {
                                            rank: "builder",
                                            promoter: player.user.username,
                                            target: target.user.username,
                                        },
                                    });
                                }
                                break;
                            default:
                                return;
                        }
                        target.save();
                    } else if (target && !value) {
                        switch (priv) {
                            case "moderator":
                                if (!target.moderator) {
                                    player.speak(
                                        "I apreciate the effort, but you can't demote someone from a rank when they don't have that rank anyway! "
                                    );
                                } else {
                                    target.user.moderator = false;
                                    target.speak(
                                        `You have been demoted from your ${priv} rank by a contributor.`,
                                        true,
                                        "tell"
                                    );
                                    player.speak("done. ");
                                    player.user.log({
                                        eventType: "demote",
                                        eventData: {
                                            rank: "player",
                                            promoter: player.user.username,
                                            target: target.user.username,
                                        },
                                    });
                                    target.user.log({
                                        eventType: "demote",
                                        eventData: {
                                            rank: "player",
                                            promoter: player.user.username,
                                            target: target.user.username,
                                        },
                                    });
                                }
                                break;
                            case "builder":
                                if (!target.builder) {
                                    player.speak(
                                        "I apreciate the effort, but you can't demote someone from a rank when they don't have that rank anyway! "
                                    );
                                } else {
                                    target.user.builder = false;
                                    target.speak(
                                        `You have been demoted from your ${priv} rank by a contributor.`,
                                        true,
                                        "tell"
                                    );
                                    player.speak("done. ");
                                    player.user.log({
                                        eventType: "demote",
                                        eventData: {
                                            rank: "player",
                                            promoter: player.user.username,
                                            target: target.user.username,
                                        },
                                    });
                                    target.user.log({
                                        eventType: "demote",
                                        eventData: {
                                            rank: "player",
                                            promoter: player.user.username,
                                            target: target.user.username,
                                        },
                                    });
                                }
                                break;
                            default:
                                return;
                        }
                        target.save();
                    }
                }
                break;
            case "rules":
                player.speak(
                    "Redirecting to https://finalhour.lowerelements.club/agreement",
                    true,
                    "main"
                );
                player.send(consts.channel_misc, "open_rules", {});
                break;
            case "help":
                const help = (
                    await fs.readFile("./help.txt", { encoding: "utf-8" })
                )
                    .trim()
                    .split(/\r?\n/);
                var help_menu = new menu(this.server, "help menu", "copy_menu");
                help_menu.add_option("help_menu", "help_menu");
                for (let i of help) {
                    help_menu.add_option(i, i);
                }
                help_menu.send(player.peer);
                break;
            case "modhelp":
                if (player.moderator) {
                    const help = (
                        await fs.readFile("./modhelp.txt", {
                            encoding: "utf-8",
                        })
                    )
                        .trim()
                        .split(/\r?\n/);
                    var help_menu = new menu(
                        this.server,
                        "mod help menu",
                        "copy_menu"
                    );
                    help_menu.add_option("help_menu", "help_menu");
                    for (let i of help) {
                        help_menu.add_option(i, i);
                    }
                    help_menu.send(player.peer);
                }
                break;
            case "builderhelp":
                if (player.builder) {
                    const help = (
                        await fs.readFile("./builderhelp.txt", {
                            encoding: "utf-8",
                        })
                    )
                        .trim()
                        .split(/\r?\n/);
                    var help_menu = new menu(
                        this.server,
                        "builder help menu",
                        "copy_menu"
                    );
                    help_menu.add_option("help_menu", "help_menu");
                    for (let i of help) {
                        help_menu.add_option(i, i);
                    }
                    help_menu.send(player.peer);
                }
                break;
            case "getmapdata":
                if (player.builder) {
                    player.send(consts.channel_map, "copy", {
                        data: player.map.real_data,
                        message: "Map data exported to your clipboard",
                    });
                }
                break;
            case "setmapdata":
                if (player.builder) {
                    const map_data = commandParts.slice(1).join(" ");
                    try {
                        await player.map.update(map_data);
                        player.speak("Done");
                    } catch (err) {
                        player.speak(`Error while updating map. ${err}`);
                    }
                }
                break;
            case "mark":
            case "mark1":
            case "mark2":
                if (player.builder) {
                    const which: 1 | 2 =
                        commandParts[0] === "mark1"
                            ? 1
                            : commandParts[0] === "mark2"
                            ? 2
                            : player.nextMark;
                    const point = {
                        x: Math.round(player.x),
                        y: Math.round(player.y),
                        z: Math.round(player.z),
                        mapName: player.map.mapName,
                    };
                    if (which === 1) {
                        player.corner1 = point;
                        if (commandParts[0] === "mark") player.nextMark = 2;
                    } else {
                        player.corner2 = point;
                        if (commandParts[0] === "mark") player.nextMark = 1;
                    }
                    player.speak(
                        `Corner ${which} marked at ${point.x}, ${point.y}, ${point.z}.`
                    );
                }
                break;
            case "unmark":
                if (player.builder) {
                    player.corner1 = undefined;
                    player.corner2 = undefined;
                    player.nextMark = 1;
                    player.speak("Markers cleared.");
                }
                break;
            case "marks":
                if (player.builder) {
                    if (!player.corner1 && !player.corner2) {
                        player.speak("No corners marked.");
                    } else {
                        const parts: string[] = [];
                        if (player.corner1)
                            parts.push(
                                `Corner 1 at ${player.corner1.x}, ${player.corner1.y}, ${player.corner1.z}.`
                            );
                        if (player.corner2)
                            parts.push(
                                `Corner 2 at ${player.corner2.x}, ${player.corner2.y}, ${player.corner2.z}.`
                            );
                        if (player.corner1 && player.corner2) {
                            const b = builder.boundsOf(
                                player.corner1,
                                player.corner2
                            );
                            parts.push(
                                `Span ${b.minx} to ${b.maxx} x, ${b.miny} to ${b.maxy} y, ${b.minz} to ${b.maxz} z.`
                            );
                        }
                        player.speak(parts.join(" "));
                    }
                }
                break;
            case "undo":
                if (player.builder) {
                    try {
                        const ok = await player.map.undo();
                        player.speak(ok ? "Undone." : "Nothing to undo.");
                    } catch (err) {
                        player.speak(`Error while undoing. ${err}`);
                    }
                }
                break;
            case "redo":
                if (player.builder) {
                    try {
                        const ok = await player.map.redo();
                        player.speak(ok ? "Redone." : "Nothing to redo.");
                    } catch (err) {
                        player.speak(`Error while redoing. ${err}`);
                    }
                }
                break;
            case "place":
                if (player.builder) {
                    await this.handlePlace(player, commandParts.slice(1));
                }
                break;
            case "repeat":
                if (player.builder) {
                    if (!player.lastPlace) {
                        player.speak("Nothing to repeat.");
                    } else {
                        const parts = player.lastPlace.split(" ");
                        if (parts[0] === "place") {
                            await this.handlePlace(player, parts.slice(1));
                        } else if (parts[0] === "here") {
                            await this.handleHere(player, parts.slice(1));
                        } else {
                            player.speak("Nothing to repeat.");
                        }
                    }
                }
                break;
            case "here":
                if (player.builder) {
                    await this.handleHere(player, commandParts.slice(1));
                }
                break;
            case "del":
                if (player.builder) {
                    await this.handleDelete(player, commandParts.slice(1));
                }
                break;
            case "setid":
                if (player.builder) {
                    await this.handleSetId(player, commandParts.slice(1));
                }
                break;
            case "setattr":
                if (player.builder) {
                    await this.handleSetAttr(player, commandParts.slice(1));
                }
                break;
            case "probe":
                if (player.builder) {
                    await this.handleProbe(player, commandParts.slice(1));
                }
                break;
            case "listids":
                if (player.builder) {
                    this.handleListIds(player);
                }
                break;
            case "whatami":
                if (player.builder) {
                    this.handleWhatAmI(player);
                }
                break;
            case "room":
                if (player.builder) {
                    await this.handleRoom(player, commandParts.slice(1));
                }
                break;
            case "ladder":
                if (player.builder) {
                    await this.handleLadder(player, commandParts.slice(1));
                }
                break;
            case "skylight":
                if (player.builder) {
                    await this.handleSkylight(player, commandParts.slice(1));
                }
                break;
            case "doorway":
                if (player.builder) {
                    await this.handleDoorway(player, commandParts.slice(1));
                }
                break;
            case "preview":
                if (player.builder) {
                    if (player.previewMode) {
                        player.speak(
                            `Preview mode is already on with ${player.previewIds.length} elements. Use /commit or /cancel.`
                        );
                    } else {
                        player.previewMode = true;
                        player.previewIds = [];
                        player.speak(
                            "Preview mode on. Every /place, /here, and macro is tentative until /commit or /cancel."
                        );
                    }
                }
                break;
            case "commit":
                if (player.builder) {
                    if (!player.previewMode) {
                        player.speak("Not in preview mode.");
                    } else if (player.previewIds.length === 0) {
                        player.previewMode = false;
                        player.speak("Preview mode off. Nothing to commit.");
                    } else {
                        try {
                            const n = await builder.commitGhosts(
                                player.map,
                                player.previewIds
                            );
                            player.previewMode = false;
                            player.previewIds = [];
                            player.speak(`Committed ${n} element${n === 1 ? "" : "s"}.`);
                        } catch (err) {
                            player.speak(`Commit failed. ${err}`);
                        }
                    }
                }
                break;
            case "cancel":
                if (player.builder) {
                    if (!player.previewMode) {
                        player.speak("Not in preview mode.");
                    } else if (player.previewIds.length === 0) {
                        player.previewMode = false;
                        player.speak("Preview mode off. Nothing to cancel.");
                    } else {
                        try {
                            const n = await builder.cancelGhosts(
                                player.map,
                                player.previewIds
                            );
                            player.previewMode = false;
                            player.previewIds = [];
                            player.speak(`Cancelled ${n} element${n === 1 ? "" : "s"}.`);
                        } catch (err) {
                            player.speak(`Cancel failed. ${err}`);
                        }
                    }
                }
                break;
            case "move":
                if (player.builder) {
                    var target = this.server.get_by_username(commandParts[1]);
                    if (!target) break;
                    var x = to_num(commandParts[2]);
                    var y = to_num(commandParts[3]);
                    var z = to_num(commandParts[4]);
                    var _map =
                        this.server.maps[commandParts[5] ?? target.map.mapName];
                    target.change_map(_map, x, y, z);
                }
                break;
            case "mkmap":
                if (player.builder && commandParts.length > 7) {
                    const name = commandParts[1];
                    const minx = to_num(commandParts[2]);
                    const maxx = to_num(commandParts[3]);
                    const miny = to_num(commandParts[4]);
                    const maxy = to_num(commandParts[5]);
                    const minz = to_num(commandParts[6]);
                    const maxz = to_num(commandParts[7]);
                    const new_map = await this.server.create_map({
                        name,
                        minx,
                        maxx,
                        miny,
                        maxy,
                        minz,
                        maxz,
                    });
                    if (new_map) {
                        player.change_map(
                            new_map,
                            minx + 1,
                            miny + 1,
                            minz + 1
                        );
                    }
                }
                break;
            case "chmap":
                if (player.builder) {
                    if (commandParts.length >= 2) {
                        const _map = this.server.maps[commandParts[1]];
                        if (_map) {
                            player.change_map(_map);
                        }
                    } else {
                        var m = new menu(
                            this.server,
                            "please choose the map to which you want to be teleported.",
                            "change_map"
                        );
                        for (let i of Object.keys(this.server.maps)) {
                            m.add_option(i, i);
                        }
                        m.send(player.peer);
                    }
                }
                break;
            case "kick":
                if (!player.moderator) break;
                var target = this.server.get_by_username(commandParts[1]);
                var reason = commandParts.slice(3).join(" ");
                if (!target) break;
                if (player.moderator) {
                    if (commandParts[2] == "public") {
                        this.server.speak(
                            `${target.user.username} was just kicked by a moderator for ${reason}`,
                            true,
                            "staff alerts",
                            "ui/notify1.ogg"
                        );
                        player.user.log({
                            eventType: "kick",
                            eventData: {
                                actioner: player.user.username,
                                actioned: target.user.username,
                                reason: reason,
                            },
                        });
                        target.user.log({
                            eventType: "kick",
                            eventData: {
                                actioner: player.user.username,
                                actioned: target.user.username,
                                reason: reason,
                            },
                        });
                    } else if (commandParts[2] == "private") {
                        this.server.speak(
                            `${target.user.username} was just kicked from the server by a moderator. `,
                            true,
                            "staff alerts",
                            "ui/notify1.ogg"
                        );
                    } else {
                        break;
                    }
                    this.server.speakmods(
                        `${target.user.username} was just kicked by ${player.user.username} for ${reason}`,
                        false,
                        "staff"
                    );
                    player.speak("done", false);
                }
                target.send(consts.channel_misc, "quit", {
                    message: `You were kicked for ${reason}`,
                });
                await target.save();
                break;
            case "asmod":
                if (player.moderator) {
                    var message = commandParts.slice(1).join(" ");
                    if (message.trim())
                        this.server.speak(
                            `Moderator: ${message}. (This message is on behalf of the Final Hour Staff team. If you experience any misconduct through one of these messages, please submit a report ticket using '/tickets'.)`,
                            true,
                            "staff alerts",
                            "ui/notify1.ogg"
                        );
                    this.server.speakmods(
                        `${player.user.username} just sent the asmod message: ${message}.`,
                        true,
                        "staff"
                    );
                    player.user.log({
                        eventType: "asmod",
                        eventData: message,
                    });
                }
                break;
            case "tellmod":
                var target = this.server.get_by_username(commandParts[1]);
                if (player.moderator && target) {
                    var message = commandParts.slice(2).join(" ");
                    player.send_pmmod(target, message);
                }
                break;
            case "conchat":
            case "c":
                if (player.contributor) {
                    var message = commandParts.slice(1).join(" ");
                    if (message.trim()) {
                        this.server.speakcontributors(
                            `Contributor chat ${player.user.username}: ${message} `,
                            false,
                            "staff",
                            "ui/notify2.ogg"
                        );
                        player.user.log_chat("conchat", message);
                        this.server.discord.send_message(
                            message,
                            channel_id.development,
                            player.user.username
                        );
                    }
                }
                break;
            case "modchat":
            case "m":
                if (player.moderator) {
                    var message = commandParts.slice(1).join(" ");
                    if (message.trim()) {
                        this.server.speakmods(
                            `Mod chat ${player.user.username}: ${message} `,
                            false,
                            "staff",
                            "ui/notify2.ogg"
                        );
                        player.user.log_chat("modchat", message);
                    }
                }
                break;
            case "buildchat":
            case "b":
                if (player.builder) {
                    var message = commandParts.slice(1).join(" ");
                    if (message.trim()) {
                        this.server.speakbuilders(
                            `builder chat ${player.user.username}: ${message} `,
                            false,
                            "staff",
                            "ui/notify2.ogg"
                        );
                        this.server.discord.send_message(message, channel_id.building, player.user.username);
                        player.user.log_chat("buildchat", message);
                    }
                }
                break;
            case "staff":
                var message = "Staff: \r\nBuilders: \r\n";
                if (player.builder) {
                    const builders = await this.server.database.users.findAll({
                        where: {
                            builder: true,
                        },
                    });
                    for (let i of builders) message += `${i.username}, `;
                    message = message + "\r\nModerators: \r\n";
                    const moderators = await this.server.database.users.findAll(
                        {
                            where: { moderator: true },
                        }
                    );
                    for (let i of moderators) message += `${i.username}, `;
                    message = message + "\r\nContributors: \r\n";
                    for (let i of this.server.contributors) message += `${i}, `;
                    player.speak(message, false, "main");
                }
                break;
            case "matches":
                if (player.contributor) {
                    player.speak(
                        `${this.server.games.length} matches are currently created`
                    );
                    for (let i of this.server.games) {
                        i.speak(
                            "A contributor would like to restart the server, you may want to destroy your match so that any highscores get saved to the leaderboard. Sorry for the inconvenience. ",
                            true,
                            "match",
                            "ui/notify1.ogg"
                        );
                    }
                }
                break;
            case "donate":
            case "d":
                var target = this.server.get_by_username(commandParts[1]);
                if (!target) break;
                var amount = to_num(commandParts[2]);
                var itemname = commandParts.slice(3).join("_");
                var item = player.inventory.find_item(itemname);
                if (item == null) {
                    player.speak("You don't have this item");
                    break;
                } else if (item.amount < amount) {
                    player.speak("You don't have enough of this item");
                    break;
                } else if (amount <= 0) {
                    player.speak("You can't give fewer than 1 item to somebody");
                    break;
                } else if (get_distance(
                    {
                        x: player.x,
                        y: player.y,
                        z: player.z
                    },
                    {
                        x: target.x,
                        y: target.y,
                        z: target.z
                    }
                ) > 5) {
                    player.speak("You are too far away");
                    break;
                }
                switch (itemname) {
                    case "frag_grenade":
                        target.inventory.add_item(
                            new Grenade(
                                this.server,
                                target,
                                amount,
                                "frag_grenade",
                                "a frag grenade",
                                30,
                                9,
                                random_number(3000, 5000)
                            )
                        );
                        player.inventory.take_item("frag_grenade", amount);
                        break;
                    case "radio":
                        target.inventory.add_item(new Item(
                            this.server,
                            target,
                            amount,
                            "radio",
                            "a radio",
                            0
                        ));
                        player.inventory.take_item(
                            "radio", amount
                        );
                        target.send(
                            consts.channel_misc,
                            "has_radio_self",
                            {
                                "enable": true
                            }
                        );
                        target.map.send(
                            consts.channel_misc,
                            "has_radio",
                            {
                                "channel": target.voice_channel,
                                "enable": true
                            }
                        );
                        if (!player.inventory.find_item("radio")) {
                            player.send(
                                consts.channel_misc,
                                "has_radio_self",
                                {
                                    "enable": false
                                }
                            );
                            player.map.send(
                                consts.channel_misc,
                                "has_radio",
                                {
                                    "channel": player.voice_channel,
                                    "enable": false
                                }
                            );    
                        }
                        break;
                    default:
                        target.inventory.add_item(
                            new Item(
                                this.server,
                                target,
                                amount,
                                itemname
                            )
                        );
                        player.inventory.take_item(
                            itemname,
                            amount
                        );
                        break;
                }
                player.speak(
                    `You just handed ${amount} ${itemname}s to ${target?.name}`,
                    true,
                    "players",
                );
                player.play_sound(
                    "items/give.ogg",
                );
                target?.speak(
                    `${player.name} just handed ${amount} ${itemname}s to you.`,
                    true,
                    "players",
                );
                target.play_sound(
                    "items/recieve.ogg"
                );

                break;
            case "give":
                if (player.moderator) {
                    var target = this.server.get_by_username(commandParts[1]);
                    if (!target) break;
                    var amount = to_num(commandParts[2]);
                    var itemname = commandParts.slice(3).join("_");
                    if (amount > 0) {
                        switch (itemname) {
                            case "grenade":
                                target.inventory.add_item(
                                    new Grenade(
                                        this.server,
                                        target,
                                        amount,
                                        "frag_grenade",
                                        "a frag grenade",
                                        30,
                                        9,
                                        random_number(3000, 5000)
                                    )
                                );
                                break;
                            case "radio":
                                target.inventory.add_item(new Item(
                                    this.server,
                                    target,
                                    amount,
                                    "radio",
                                    "a radio",
                                    0
                                ));
                                target.send(
                                    consts.channel_misc,
                                    "has_radio_self",
                                    {
                                        "enable": true
                                    }
                                );
                                target.map.send(
                                    consts.channel_misc,
                                    "has_radio",
                                    {
                                        "channel": target.voice_channel,
                                        "enable": true
                                    }
                                );
                                break;
                            default:
                                target.inventory.add_item(
                                    new Item(
                                        this.server,
                                        target,
                                        amount,
                                        itemname
                                    )
                                );
                                break;
                        }
                    } else if (amount < 0) {
                        target.inventory.take_item(itemname, amount * -1);
                    }
                    this.server.speakmods(
                        `${
                            player.user.username
                        } just gave ${amount.toString()} ${itemname} to ${
                            target.user.username
                        }`,
                        false,
                        "staff",
                        "ui/notify2.ogg"
                    );
                    target.speak(
                        `You were just given ${amount.toString()} ${itemname} by a moderator. `,
                        true,
                        "main"
                    );
                    target.user.log({
                        eventType: "give",
                        eventData: {
                            amount: amount,
                            provider: player.user.username,
                            receiver: target.user.username,
                            item: itemname,
                        },
                    });
                    player.user.log({
                        eventType: "give",
                        eventData: {
                            amount: amount,
                            provider: player.user.username,
                            receiver: target.user.username,
                            item: itemname,
                        },
                    });
                }
                break;
            case "modtell":
                var message = commandParts.slice(1).join(" ");
                this.server.speakmods(
                    `${player.user.username} just sent the modtell: ${message}`,
                    false,
                    "staff",
                    "ui/notify2.ogg"
                );
                player.speak(
                    `You just sent the modtell: ${message}`,
                    true,
                    "main"
                );
                player.user.log({
                    eventType: "modtell",
                    eventData: message,
                });
                break;
            case "sethp":
                if (player.moderator) {
                    var target = this.server.get_by_username(commandParts[1]);
                    if (!target) break;
                    var amount = to_num(commandParts[2]);
                    target.set_hp(amount);
                    player.speak("done");
                    target.speak(
                        `A moderator just set your health to ${amount.toString()}.`,
                        true,
                        "main"
                    );
                    this.server.speakmods(
                        `${player.user.username} just set ${
                            target.user.username
                        }'s health to ${amount.toString()}. `,
                        false,
                        "staff",
                        "ui/notify2.ogg"
                    );
                    player.user.log({
                        eventType: "set_hp",
                        eventData: {
                            hp: amount,
                            actioner: player.user.username,
                            actioned: target.user.username,
                        },
                    });
                    target.user.log({
                        eventType: "set_hp",
                        eventData: {
                            hp: amount,
                            actioner: player.user.username,
                            actioned: target.user.username,
                        },
                    });
                }
                break;
            case "find_path":
                var x = to_num(commandParts[1]);
                var y = to_num(commandParts[2]);
                var z = to_num(commandParts[3]);
                player.speak(
                    `${await player.map.find_path(
                        player.x,
                        player.y,
                        player.z,
                        x,
                        y,
                        z
                    )}`
                );
                break;
            case "mainmenu":
                player.main_menu();
                break;
            case "invisible":
                if (player.contributor) {
                    player.toggle_invis();
                }
                break;
            case "tickets":
                var tickets: any[] = [];
                if (commandParts[1] == "closed") {
                    var sql_tickets =
                        await this.server.database.tickets.get_closed_tickets();
                    for (var ticket of sql_tickets) {
                        tickets.push({
                            id: ticket.ticket_id,
                            author: ticket.author,
                            category: ticket.category,
                            status: ticket.status,
                            message_list: ticket.message_list,
                        });
                    }
                    var mod = false;
                    if (player.moderator) {
                        mod = true;
                    }
                    player.send(consts.channel_menus, "view_closed_tickets", {
                        tickets: tickets,
                        moderator: mod,
                    });
                } else if (commandParts[1] == "building" && player.builder) {
                    const sql_tickets =
                        await this.server.database.tickets.get_building_tickets();
                    for (var ticket of sql_tickets) {
                        tickets.push({
                            id: ticket.ticket_id,
                            author: ticket.author,
                            category: ticket.category,
                            status: ticket.status,
                            message_list: ticket.message_list,
                        });
                    }

                    var mod = false;
                    if (player.moderator) {
                        mod = true;
                    }
                    player.send(consts.channel_menus, "tickets_menu", {
                        tickets: tickets,
                        moderator: mod,
                    });
                } else if (commandParts[1] == "staff" && player.moderator) {
                    const sql_tickets =
                        await this.server.database.tickets.get_open_tickets();
                    for (var ticket of sql_tickets) {
                        tickets.push({
                            id: ticket.ticket_id,
                            author: ticket.author,
                            category: ticket.category,
                            status: ticket.status,
                            message_list: ticket.message_list,
                        });
                    }

                    var mod = false;
                    if (player.moderator) {
                        mod = true;
                    }
                    player.send(consts.channel_menus, "view_closed_tickets", {
                        tickets: tickets,
                        moderator: mod,
                    });
                } else {
                    const sql_tickets =
                        await this.server.database.tickets.get_all_tickets_by_userid(
                            player.user.id
                        );
                    for (var ticket of sql_tickets) {
                        tickets.push({
                            id: ticket.ticket_id,
                            author: ticket.author,
                            category: ticket.category,
                            status: ticket.status,
                            message_list: ticket.message_list,
                        });
                    }
                    var mod = false;
                    if (player.moderator) {
                        mod = true;
                    }
                    player.send(consts.channel_menus, "tickets_menu", {
                        tickets: tickets,
                        moderator: mod,
                    });
                }
                break;
            case "block":
                var target_name = commandParts[1];
                if (player.user.blocked_players.includes(target_name)) {
                    player.speak(`You've already blocked ${target_name}`);
                    break;
                }
                var target = this.server.get_by_username(target_name);

                if (
                    target && 
                    target instanceof Player && 
                    !target.moderator
                ) {
                    target.user.block_list = target.user.block_list.concat([player.user.username]);
                    player.user.blocked_players = player.user.blocked_players.concat([target_name])
                    await target.user.save();
                    await player.user.save();
                    player.speak(`You just blocked ${target.name}`);
                } else if (await this.server.database.users.username_exists(target_name)) {
                    var target_user = await this.server.database.users.get_by_username(target_name);
                    if (
                        target_user instanceof User &&
                        !target_user.moderator &&
                        !this.server.contributors.includes(target_name)
                    ) {
                        target_user.block_list = target_user.block_list.concat([player.user.username]);
                        player.user.blocked_players = player.user.blocked_players.concat([target_name]);
                        target_user.save()
                        player.user.save();
                        player.speak(`You have blocked ${target_user.username}.`);
                    }
                } else {
                    player.speak("Error, invalid player name");
                } 
                if (target?.moderator || this.server.contributors.includes(target_name)) {
                    player.speak("You can't mute moderators");
                }
                
                break;
            case "unblock":
                var target = this.server.get_by_username(commandParts[1]);
                if (target && target instanceof Player) {
                    target.user.block_list = 
                    target.user.block_list.slice(0, target.user.block_list.indexOf(player.user.username))
                    .concat(target.user.block_list.slice(target.user.block_list.indexOf(player.user.username)+1));
                    player.user.blocked_players = 
                    player.user.blocked_players.slice(0, player.user.blocked_players.indexOf(target.user.username))
                    .concat(player.user.blocked_players.slice(player.user.blocked_players.indexOf(target.user.username)+1));
                    await target.user.save();
                    await player.user.save();
                    player.speak(`${target.user.username} unblocked. `);
                } else if (!target && await this.server.database.users.username_exists(commandParts[1])) {
                    var target_user = await this.server.database.users.get_by_username(commandParts[1]);
                    target_user.block_list = 
                    target_user.block_list.slice(0, target_user.block_list.indexOf(player.user.username))
                    .concat(target_user.block_list.slice(target_user.block_list.indexOf(player.user.username)+1));
                    player.user.blocked_players = 
                    player.user.blocked_players.slice(0, player.user.blocked_players.indexOf(target_user.username))
                    .concat(player.user.blocked_players.slice(player.user.blocked_players.indexOf(target_user.username)+1));
                    await target_user.save();
                    await player.user.save();
                    player.speak(`${target_user.username} unblocked. `);

                } else {
                    player.speak("That player either doesn't exist or isn't on your block list");
                }

                break;
            case "blockslist":
                if (player.user.blocked_players.length < 1) {
                    player.speak("You have blocked no body", true, "main");
                } else {
                    var message = "You have blocked: \r\n";
                    for (let block of player.user.blocked_players) {
                        if (player.user.blocked_players.indexOf(block) == player.user.blocked_players.length - 1) message = `${message}${block}.\r\n`
                        else if (player.user.blocked_players.indexOf(block) == player.user.blocked_players.length -2) message = `${message}${block}, \r\nand\r\n`;
                        else message = `${message}${block},\r\n`;
                    }
                    player.speak(message, true, "main");
                }
                break;
            
                case "permban":
                    if (!player.moderator) break;
                    var target = this.server.get_by_username(commandParts[1]);
                    if (!target) {
                        player.speak("This player does not exist");
                        break;
                    }
                    var IP: boolean;
                    if (commandParts[2].toUpperCase() == "IP") IP = true;
                    else if (commandParts[2].toLowerCase() == "account_only") IP = false;
                    else {
                        player.speak("Invalid option for ban type, options are IP or account_only");
                        break;
                    }
                    var public_reason: boolean;
                    if (commandParts[3].toLowerCase() == "public") public_reason = true;
                    else public_reason = false;
                    var reason = commandParts.slice(4).join(" ");
                    target.user.permban = true;
                    target.user.banReason = reason;
                    if (IP) {
                        target.user.IPBans = target.user.IPBans.concat([target.peer.address().address]);
                        var ban = await this.server.database.IPBans.create({
                            permban: true,
                            tempban: false,
                            IP: target.peer.address().address,
                            reason: reason,
                            expiryDate: 0
                        });
                        await ban.save();

                    }
                    var message: string;
                    if (public_reason) message = `${target.user.username} has been banned. Reason: ${reason}`;
                    else message = `${target.user.username} has been banned.`;
                    this.server.speak(message, false, "notifications", "ui/notify1.ogg");
                    this.server.speakmods(`${player.user.username} has banned ${target.user.username} for ${reason}`, true, "staff", "ui/notify2.ogg");
                    target.send(consts.channel_misc, "quit", {
                        message: `You have been banned. Reason: ${reason}`
                    });
                    await target.save()
                    break;
                case "unban":
                    if (!player.moderator) break;
                    if (await this.server.database.users.username_exists(commandParts[1])) {
                        let user = await this.server.database.users.findOne({
                            where: { normalized_username: commandParts[1].toLowerCase() },
                        });
                        if (!user) {
                            player.speak("Invalid username");
                            break;
                        }
                        if (user.IPBans.length == 0 && !user.permban) {
                            player.speak("This player is not banned")
                            break;
                        }
                        user.permban = false;
                        for (let ban of user.IPBans) {
                            var IP_ban = await this.server.database.IPBans.findOne({
                                where: { IP: ban }
                            })
                            if (IP_ban instanceof IPBan) await IP_ban.destroy();
                        }
                        await user.save();
                        this.server.speak(`${user.username} was just unbanned.`, false, "notifications", "ui/notify1.ogg");
                        this.server.speakmods(`${player.user.username} just unbanned ${user.username}.`, true, "staff", "ui/notify2.ogg");
                    }
                    break;
                case "banlist":
                    if (!player.moderator) break;
                    const types = commandParts.slice(1);
                    message = "Bans:\r\n";
                    for (let type of types) {
                        if (type.toLowerCase() == "users") {
                            var users = await this.server.database.users.findAll({
                                where: { permban: true }
                            });
                            for (let user of users) message = `${message}${user.username}, `;
                        } else if (type.toLowerCase() == "ips") {
                            const ips = await this.server.database.IPBans.findAll();
                            for (let IP of ips) message = `${message}${IP.IP}, `;
                        }
                    }
                    break;
                case "tempban":
                    if (!player.moderator) break;
                    var target = this.server.get_by_username(commandParts[1])
                    var month = 0;
                    var day = 1;
                    var year = 2026
                    var hour = 0;
                    var minute = 0;
                    var second = 0;
                    const date_string = commandParts[2].split(":");
                    if (date_string[0]) month = to_num(date_string[0])-1;
                    if (date_string[1]) day = to_num(date_string[1]);
                    if (date_string[2]) year = to_num(date_string[2]);
                    if (date_string[3]) hour = to_num(date_string[3]);
                    if (date_string[4]) minute = to_num(date_string[4]);
                    if (date_string[5]) second = to_num(date_string[5]);
                    var ban = await this.server.database.IPBans.create({
                        IP: target?.peer.address().address,
                        permban: false,
                        tempban: true,
                        expiryDate: Date.UTC(year, month, day, hour, minute, second),
                        reason: commandParts.slice(3).join(" ")
                    });
                    message = `${target?.user.username} has been banned until ${new Date(ban.expiryDate).toDateString()} for ${ban.reason}.`;
                    this.server.speak(message, false, "notifications", "ui/notify1.ogg");
                    this.server.speakmods(`${player.user.username} has banned ${target?.user.username} for ${ban.reason}, until ${new Date(ban.expiryDate).toString()}`, true, "staff", "ui/notify2.ogg");
                    target?.send(consts.channel_misc, "quit", {
                        message: `You have been banned until ${new Date(ban.expiryDate).toString()}. For ${ban.reason}`
                    });
                    if (target && target.user.IPBans) target.user.IPBans = target?.user.IPBans.concat([ban.IP]);
                    await target?.user.save()
                    break;
            case "mute":
                var target = this.server.get_by_username(commandParts[1]);
                if (target && !target.user.muted && player.moderator) {
                    var reason = commandParts.slice(2).join(" ");
                    target.user.muted = true;
                    target.speak(
                        `You have been muted by a moderator for ${reason}`,
                        true,
                        "staff alerts",
                        "ui/notify1.ogg"
                    );
                    player.user.log({
                        eventType: "mute",
                        eventData: {
                            actioner: player.user.username,
                            actioned: target.user.username,
                            reason: reason,
                        },
                    });
                    target.user.log({
                        eventType: "mute",
                        eventData: {
                            actioner: player.user.username,
                            actioned: target.user.username,
                            reason: reason,
                        },
                    });
                    this.server.speakmods(
                        `${player.user.username} just muted ${target.user.username} for ${reason}`,
                        true,
                        "staff",
                        "ui/notify2.ogg"
                    );
                }
                break;
            case "unmute":
                var target = this.server.get_by_username(commandParts[1]);
                if (target && target.user.muted && player.moderator) {
                    target.user.muted = false;
                    target.speak(
                        `You have been unmuted by a moderator`,
                        true,
                        "staff alerts",
                        "ui/notify1.ogg"
                    );
                    player.user.log({
                        eventType: "unmute",
                        eventData: {
                            actioner: player.user.username,
                            actioned: target.user.username,
                        },
                    });
                    target.user.log({
                        eventType: "unmute",
                        eventData: {
                            actioner: player.user.username,
                            actioned: target.user.username,
                        },
                    });
                    this.server.speakmods(
                        `${player.user.username} just unmuted ${target.user.username}`,
                        true,
                        "staff",
                        "ui/notify2.ogg"
                    );
                }
                break;
            case "mc":
            case "mapchat":
                this.events.map_chat.bind(this)(player.peer, {
                    message: commandParts.slice(1).join(" "),
                });
                break;
            case "nickname":
            case "n":
                var nickname = commandParts.slice(1).join(" ");
                if (
                    nickname.length >= 3 &&
                    nickname.length <= 26 &&
                    player.user.nickname != nickname
                ) {
                    player.user.log({
                        eventType: "nickname",
                        eventData: {
                            first: player.user.nickname,
                            second: nickname,
                        },
                    });
                    player.user.nickname = nickname;
                    this.server.speak(
                        `${player.user.username} has changed their nickname to ${player.user.nickname}`,
                        false,
                        "notifications"
                    );
                    player.save();
                } else {
                    player.speak("invalid length");
                }
                break;
            case "create_behavior":
                if (player.builder) {
                    let behaviorName = commandParts[1];
                    if (behaviorName) {
                        const behaviorData = commandParts.slice(2).join(" ");
                        if (behaviorData) {
                            parseBehaviorTreeNode(
                                parseBehaviorTreeXml(behaviorData),
                                new Blackboard(player)
                            );
                            this.server.database.behaviors.create({
                                name: behaviorName,
                                xmlData: behaviorData,
                            });
                        }
                    }
                }
            case "logs":
                if (player.moderator) {
                    try {
                        var query_string = commandParts
                            .slice(2)
                            .join(" ")
                            .trim()
                            .toLowerCase();
                        if (query_string.startsWith("where ")) {
                            query_string = query_string.replace("where ", "");
                        }
                        const filter = await parse_log_query(
                            this.server,
                            query_string
                        );
                        switch (commandParts[1].toLowerCase()) {
                            case "select":
                                const log_entries =
                                    await this.server.logs.query(filter);
                                if (log_entries) {
                                    let log_text = "";
                                    for (let log_entry of log_entries) {
                                        log_text += `${logged_entry_to_string(
                                            log_entry
                                        )}\n`;
                                    }
                                    player.send(consts.channel_misc, "copy", {
                                        data: log_text,
                                        message: `Matched ${log_entries.length} entries. Copied to clipboard`,
                                    });
                                }
                                player.user.log({
                                    eventType: "log_access",
                                    eventData: {
                                        query: query_string,
                                    },
                                });
                                break;
                            case "count":
                                player.speak(
                                    `Matched ${await this.server.logs.countLogs(
                                        filter
                                    )}`
                                );
                        }
                    } catch (err) {
                        player.speak((err as Error).message);
                    }
                }
        }
    }
    private withGhost(
        player: Player,
        attrs: Record<string, string | number | boolean | undefined>
    ): Record<string, string | number | boolean> {
        const out = this.withGhost(player,attrs);
        if (player.previewMode) {
            const existing = out.class ? String(out.class) : "";
            out.class = existing ? `${existing} ghost` : "ghost";
            player.previewIds.push(String(out.id));
        }
        return out;
    }
    private getMarkBounds(player: Player): builder.ElementBounds | null {
        if (!player.corner1 || !player.corner2) {
            player.speak("Both corners must be marked first. Use /mark twice.");
            return null;
        }
        if (
            player.corner1.mapName !== player.map.mapName ||
            player.corner2.mapName !== player.map.mapName
        ) {
            player.speak(
                "Corners were marked on a different map. Use /unmark and re-mark."
            );
            return null;
        }
        return builder.boundsOf(player.corner1, player.corner2);
    }
    async handlePlace(player: Player, args: string[]): Promise<void> {
        const type = args[0];
        if (!type) {
            player.speak("Usage: /place <type> [args]");
            return;
        }
        const bounds = this.getMarkBounds(player);
        if (!bounds) return;
        const boundsAttr = builder.boundsString(bounds);
        try {
            let line: string;
            let label: string;
            switch (type) {
                case "platform": {
                    const tileType = args[1];
                    if (!tileType) {
                        player.speak("Usage: /place platform <tiletype> [class]");
                        return;
                    }
                    line = builder.serializeElement(
                        "platform",
                        this.withGhost(player,{
                            bounds: boundsAttr,
                            type: tileType,
                            class: args[2],
                        })
                    );
                    label = `${tileType} platform`;
                    break;
                }
                case "door": {
                    const walltype = args[1];
                    const tiletype = args[2];
                    const minpoints = args[3];
                    if (!walltype || !tiletype || minpoints === undefined) {
                        player.speak(
                            "Usage: /place door <walltype> <tiletype> <minpoints> [activates] [class]"
                        );
                        return;
                    }
                    line = builder.serializeElement(
                        "door",
                        this.withGhost(player,{
                            bounds: boundsAttr,
                            walltype,
                            tiletype,
                            minpoints,
                            activates: args[4],
                            class: args[5],
                        })
                    );
                    label = `${walltype}/${tiletype} door`;
                    break;
                }
                case "zone": {
                    const name = args.slice(1).join(" ").trim();
                    if (!name) {
                        player.speak("Usage: /place zone <name…>");
                        return;
                    }
                    line = builder.serializeElement(
                        "zone",
                        this.withGhost(player,{ bounds: boundsAttr }),
                        name
                    );
                    label = `zone "${name}"`;
                    break;
                }
                case "playerSpawn":
                    line = builder.serializeElement(
                        "playerSpawn",
                        this.withGhost(player,{ bounds: boundsAttr, class: args[1] })
                    );
                    label = "player spawn";
                    break;
                case "zombieSpawn":
                    line = builder.serializeElement(
                        "zombieSpawn",
                        this.withGhost(player,{
                            bounds: boundsAttr,
                            name: args[1],
                            zBound: args[2],
                        })
                    );
                    label = "zombie spawn";
                    break;
                case "wallbuy": {
                    const weapon = args[1];
                    const weaponCost = args[2];
                    const ammoCost = args[3];
                    if (!weapon || weaponCost === undefined || ammoCost === undefined) {
                        player.speak(
                            "Usage: /place wallbuy <weapon> <weaponCost> <ammoCost>"
                        );
                        return;
                    }
                    line = builder.serializeElement(
                        "wallbuy",
                        this.withGhost(player,{
                            bounds: boundsAttr,
                            weaponName: weapon,
                            weaponCost,
                            ammoCost,
                        })
                    );
                    label = `${weapon} wallbuy`;
                    break;
                }
                case "interactable":
                    line = builder.serializeElement(
                        "interactable",
                        this.withGhost(player,{ bounds: boundsAttr, class: args[1] })
                    );
                    label = "interactable";
                    break;
                case "ambience": {
                    const sound = args[1];
                    if (!sound) {
                        player.speak("Usage: /place ambience <sound> [volume]");
                        return;
                    }
                    line = builder.serializeElement(
                        "ambience",
                        this.withGhost(player,{
                            bounds: boundsAttr,
                            sound,
                            volume: args[2],
                        })
                    );
                    label = `ambience ${sound}`;
                    break;
                }
                case "soundSource": {
                    const sound = args[1];
                    if (!sound) {
                        player.speak("Usage: /place soundSource <sound> [volume]");
                        return;
                    }
                    line = builder.serializeElement(
                        "soundSource",
                        this.withGhost(player,{
                            bounds: boundsAttr,
                            sound,
                            volume: args[2],
                        })
                    );
                    label = `sound source ${sound}`;
                    break;
                }
                case "music": {
                    const sound = args[1];
                    if (!sound) {
                        player.speak("Usage: /place music <sound>");
                        return;
                    }
                    line = builder.serializeElement(
                        "music",
                        this.withGhost(player,{ bounds: boundsAttr, sound })
                    );
                    label = `music ${sound}`;
                    break;
                }
                case "reverb": {
                    const kv = this.parseKV(args.slice(1));
                    line = builder.serializeElement(
                        "reverb",
                        this.withGhost(player,{ bounds: boundsAttr, ...kv })
                    );
                    label = "reverb";
                    break;
                }
                default:
                    player.speak(`Unknown element type: ${type}.`);
                    return;
            }
            await builder.insertElement(player.map, line);
            player.lastPlace = `place ${args.join(" ")}`;
            player.speak(`Placed ${label}${player.previewMode ? " (preview)" : ""}.`);
        } catch (err) {
            player.speak(`Place failed. ${err}`);
        }
    }
    async handleHere(player: Player, args: string[]): Promise<void> {
        const type = args[0];
        if (!type) {
            player.speak("Usage: /here <type> [args]");
            return;
        }
        const x = Math.round(player.x);
        const y = Math.round(player.y);
        const z = Math.round(player.z);
        const positionAttr = `${x} ${y} ${z}`;
        try {
            let line: string;
            let label: string;
            switch (type) {
                case "perkMachine": {
                    const perk = args[1];
                    if (!perk) {
                        player.speak(
                            "Usage: /here perkMachine <perk> [price] [quantity] [sound]"
                        );
                        return;
                    }
                    line = builder.serializeElement(
                        "perkMachine",
                        this.withGhost(player,{
                            position: positionAttr,
                            perk,
                            price: args[2],
                            quantity: args[3],
                            sound: args[4],
                        })
                    );
                    label = `${perk} perk machine`;
                    break;
                }
                case "powerSwitch":
                    line = builder.serializeElement(
                        "powerSwitch",
                        this.withGhost(player,{
                            position: positionAttr,
                            cost: args[1] ?? "0",
                        })
                    );
                    label = "power switch";
                    break;
                case "window":
                    line = builder.serializeElement(
                        "window",
                        this.withGhost(player,{
                            position: positionAttr,
                            hp: args[1] ?? "1000",
                        })
                    );
                    label = "window";
                    break;
                case "pannable": {
                    const sound = args[1];
                    if (!sound) {
                        player.speak("Usage: /here pannable <sound> [volume]");
                        return;
                    }
                    line = builder.serializeElement(
                        "pannable",
                        this.withGhost(player,{
                            position: positionAttr,
                            sound,
                            volume: args[2],
                        })
                    );
                    label = `pannable ${sound}`;
                    break;
                }
                default:
                    player.speak(`Unknown point element type: ${type}.`);
                    return;
            }
            await builder.insertElement(player.map, line);
            player.lastPlace = `here ${args.join(" ")}`;
            player.speak(`Placed ${label} at ${x}, ${y}, ${z}${player.previewMode ? " (preview)" : ""}.`);
        } catch (err) {
            player.speak(`Place failed. ${err}`);
        }
    }
    parseKV(args: string[]): Record<string, string> {
        const out: Record<string, string> = {};
        for (const a of args) {
            const eq = a.indexOf("=");
            if (eq < 0) continue;
            const k = a.slice(0, eq);
            const v = a.slice(eq + 1);
            if (k) out[k] = v;
        }
        return out;
    }
    async handleDelete(player: Player, args: string[]): Promise<void> {
        const x = Math.round(player.x);
        const y = Math.round(player.y);
        const z = Math.round(player.z);
        try {
            if (args.length >= 1) {
                const arg = args[0];
                const asIndex = parseInt(arg, 10);
                const pending = this.pendingDeletes.get(player.user.username);
                if (pending && !isNaN(asIndex) && asIndex >= 1 && asIndex <= pending.ids.length) {
                    const id = pending.ids[asIndex - 1];
                    this.pendingDeletes.delete(player.user.username);
                    const el = await builder.deleteElementById(player.map, id);
                    player.speak(
                        el
                            ? `Deleted ${el.elementName}.`
                            : `No element with that id was found.`
                    );
                    return;
                }
                const el = await builder.deleteElementById(player.map, arg);
                player.speak(
                    el
                        ? `Deleted ${el.elementName}.`
                        : `No element with id "${arg}" was found.`
                );
                return;
            }
            const here = builder.elementsAt(player.map, x, y, z);
            if (here.length === 0) {
                player.speak("Nothing here to delete.");
                return;
            }
            if (here.length === 1) {
                const el = await builder.deleteElementById(
                    player.map,
                    here[0].id
                );
                player.speak(
                    el ? `Deleted ${el.elementName}.` : `Delete failed.`
                );
                return;
            }
            this.pendingDeletes.set(player.user.username, {
                ids: here.map((e) => e.id),
            });
            const summary = here
                .map((e, i) => `${i + 1}: ${e.elementName} ${e.id}`)
                .join("; ");
            player.speak(
                `Multiple elements here. Choose with /del <number>. ${summary}.`
            );
        } catch (err) {
            player.speak(`Delete failed. ${err}`);
        }
    }
    pendingDeletes = new Map<string, { ids: string[] }>();
    async handleSetId(player: Player, args: string[]): Promise<void> {
        if (args.length < 2) {
            player.speak("Usage: /setid <oldId|here> <newId>");
            return;
        }
        const oldArg = args[0];
        const newId = args[1];
        try {
            if (oldArg === "here") {
                const here = builder.elementsAt(
                    player.map,
                    Math.round(player.x),
                    Math.round(player.y),
                    Math.round(player.z)
                );
                if (here.length === 0) {
                    player.speak("Nothing here to rename.");
                    return;
                }
                if (here.length > 1) {
                    player.speak(
                        "Multiple elements here; rename by explicit id instead."
                    );
                    return;
                }
                const ok = await builder.renameElementId(
                    player.map,
                    here[0].id,
                    newId
                );
                player.speak(ok ? `Renamed to ${newId}.` : "Rename failed.");
                return;
            }
            const ok = await builder.renameElementId(
                player.map,
                oldArg,
                newId
            );
            player.speak(ok ? `Renamed to ${newId}.` : `No element with id "${oldArg}".`);
        } catch (err) {
            player.speak(`Rename failed. ${err}`);
        }
    }
    async handleSetAttr(player: Player, args: string[]): Promise<void> {
        if (args.length < 3) {
            player.speak("Usage: /setattr <id> <attr> <value>");
            return;
        }
        const [id, attr, ...rest] = args;
        const value = rest.join(" ");
        try {
            const ok = await builder.setElementAttr(player.map, id, attr, value);
            player.speak(ok ? `Updated ${attr}.` : `No element with id "${id}".`);
        } catch (err) {
            player.speak(`Update failed. ${err}`);
        }
    }
    async handleProbe(player: Player, args: string[]): Promise<void> {
        const r = args[0] ? to_num(args[0]) : 2;
        const here = builder.elementsWithin(
            player.map,
            Math.round(player.x),
            Math.round(player.y),
            Math.round(player.z),
            r
        );
        if (here.length === 0) {
            player.speak("Nothing within reach.");
            return;
        }
        const parts = here.map((e) => {
            const p = e.properties as any;
            const desc =
                e.elementName === "platform"
                    ? `${p.type} platform`
                    : e.elementName === "zone"
                    ? `zone "${p.innerText ?? ""}"`
                    : e.elementName === "door"
                    ? `${p.walltype}/${p.tiletype} door`
                    : e.elementName;
            return `${desc} at ${e.minx},${e.miny},${e.minz}-${e.maxx},${e.maxy},${e.maxz} (id ${e.id})`;
        });
        player.speak(`Within ${r}: ${parts.join("; ")}.`);
    }
    handleListIds(player: Player): void {
        const x = Math.round(player.x);
        const y = Math.round(player.y);
        const z = Math.round(player.z);
        let zoneName: string | undefined;
        for (const el of player.map.allElements) {
            if (el.elementName === "zone" && el.in_bound(x, y, z)) {
                zoneName = (el.properties as any).innerText;
                break;
            }
        }
        if (!zoneName) {
            const ids = player.map.allElements
                .filter((e) => !e.id.startsWith("_"))
                .map((e) => `${e.elementName}=${e.id}`);
            player.speak(`No zone here. Map ids: ${ids.slice(0, 20).join("; ")}.`);
            return;
        }
        const inZone: string[] = [];
        for (const el of player.map.allElements) {
            if (el.elementName === "zone") continue;
            if (
                el.intersects({
                    minx: x - 50,
                    maxx: x + 50,
                    miny: y - 50,
                    maxy: y + 50,
                    minz: z - 50,
                    maxz: z + 50,
                })
            ) {
                inZone.push(`${el.elementName}=${el.id}`);
            }
        }
        player.speak(
            `Zone "${zoneName}" nearby ids: ${inZone.slice(0, 20).join("; ")}.`
        );
    }
    async handleRoom(player: Player, args: string[]): Promise<void> {
        const bounds = this.getMarkBounds(player);
        if (!bounds) return;
        const opts = this.parseKV(args);
        const walls = opts.walls ?? "wallwood";
        const floor = opts.floor ?? "wood";
        const ceil = opts.ceil ?? "wood";
        const door = (opts.door ?? "none").toUpperCase();
        const { minx, maxx, miny, maxy, minz, maxz } = bounds;
        if (minz === maxz) {
            player.speak("Room needs a vertical span. Mark corners at different z values.");
            return;
        }
        try {
            const lines: string[] = [];
            const wall = (b: builder.ElementBounds) =>
                builder.serializeElement(
                    "platform",
                    this.withGhost(player,{ bounds: builder.boundsString(b), type: walls })
                );
            lines.push(
                wall({ minx, maxx, miny, maxy: miny, minz, maxz })
            );
            lines.push(
                wall({ minx, maxx, miny: maxy, maxy, minz, maxz })
            );
            lines.push(
                wall({ minx, maxx: minx, miny, maxy, minz, maxz })
            );
            lines.push(
                wall({ minx: maxx, maxx, miny, maxy, minz, maxz })
            );
            lines.push(
                builder.serializeElement(
                    "platform",
                    this.withGhost(player,{
                        bounds: builder.boundsString({
                            minx,
                            maxx,
                            miny,
                            maxy,
                            minz,
                            maxz: minz,
                        }),
                        type: floor,
                    })
                )
            );
            lines.push(
                builder.serializeElement(
                    "platform",
                    this.withGhost(player,{
                        bounds: builder.boundsString({
                            minx,
                            maxx,
                            miny,
                            maxy,
                            minz: maxz,
                            maxz,
                        }),
                        type: ceil,
                    })
                )
            );
            if (door !== "NONE") {
                const doorH = Math.min(3, maxz - minz);
                const doorBounds = this.computeDoorBounds(bounds, door, doorH);
                if (!doorBounds) {
                    player.speak(`Unknown door direction "${door}".`);
                    return;
                }
                lines.push(
                    builder.serializeElement(
                        "door",
                        this.withGhost(player,{
                            bounds: builder.boundsString(doorBounds),
                            walltype: walls,
                            tiletype: floor,
                            minpoints: "0",
                        })
                    )
                );
            }
            await builder.insertElements(player.map, lines);
            player.speak(
                `Built room: walls=${walls}, floor=${floor}, ceil=${ceil}${
                    door !== "NONE" ? `, door=${door}` : ""
                }${player.previewMode ? " (preview)" : ""}.`
            );
        } catch (err) {
            player.speak(`Room failed. ${err}`);
        }
    }
    computeDoorBounds(
        b: builder.ElementBounds,
        dir: string,
        height: number
    ): builder.ElementBounds | null {
        const cx = Math.round((b.minx + b.maxx) / 2);
        const cy = Math.round((b.miny + b.maxy) / 2);
        const top = b.minz + height;
        switch (dir) {
            case "N":
                return {
                    minx: cx,
                    maxx: cx,
                    miny: b.miny,
                    maxy: b.miny,
                    minz: b.minz,
                    maxz: top,
                };
            case "S":
                return {
                    minx: cx,
                    maxx: cx,
                    miny: b.maxy,
                    maxy: b.maxy,
                    minz: b.minz,
                    maxz: top,
                };
            case "W":
                return {
                    minx: b.minx,
                    maxx: b.minx,
                    miny: cy,
                    maxy: cy,
                    minz: b.minz,
                    maxz: top,
                };
            case "E":
                return {
                    minx: b.maxx,
                    maxx: b.maxx,
                    miny: cy,
                    maxy: cy,
                    minz: b.minz,
                    maxz: top,
                };
            default:
                return null;
        }
    }
    async handleLadder(player: Player, args: string[]): Promise<void> {
        const bounds = this.getMarkBounds(player);
        if (!bounds) return;
        const opts = this.parseKV(args);
        const dir = (opts.dir ?? "N").toUpperCase();
        const type = opts.type ?? "metal";
        const cx = Math.round((bounds.minx + bounds.maxx) / 2);
        const cy = Math.round((bounds.miny + bounds.maxy) / 2);
        let x: number, y: number;
        switch (dir) {
            case "N":
                x = cx;
                y = bounds.miny;
                break;
            case "S":
                x = cx;
                y = bounds.maxy;
                break;
            case "W":
                x = bounds.minx;
                y = cy;
                break;
            case "E":
                x = bounds.maxx;
                y = cy;
                break;
            default:
                player.speak(`Unknown ladder direction "${dir}".`);
                return;
        }
        try {
            const line = builder.serializeElement(
                "platform",
                this.withGhost(player,{
                    bounds: builder.boundsString({
                        minx: x,
                        maxx: x,
                        miny: y,
                        maxy: y,
                        minz: bounds.minz,
                        maxz: bounds.maxz,
                    }),
                    type,
                })
            );
            await builder.insertElement(player.map, line);
            player.speak(
                `Built ${type} ladder at ${x},${y} from z=${bounds.minz} to ${bounds.maxz}${player.previewMode ? " (preview)" : ""}.`
            );
        } catch (err) {
            player.speak(`Ladder failed. ${err}`);
        }
    }
    async handleSkylight(player: Player, args: string[]): Promise<void> {
        const bounds = this.getMarkBounds(player);
        if (!bounds) return;
        const opts = this.parseKV(args);
        const walltype = opts.walltype ?? "wallglass";
        const floor = opts.floor ?? "wood";
        const { minx, maxx, miny, maxy, maxz } = bounds;
        try {
            const lines: string[] = [];
            lines.push(
                builder.serializeElement(
                    "platform",
                    this.withGhost(player,{
                        bounds: builder.boundsString({
                            minx: minx - 1,
                            maxx: maxx + 1,
                            miny: miny - 1,
                            maxy: maxy + 1,
                            minz: maxz,
                            maxz,
                        }),
                        type: floor,
                    })
                )
            );
            lines.push(
                builder.serializeElement(
                    "door",
                    this.withGhost(player,{
                        bounds: builder.boundsString({
                            minx,
                            maxx,
                            miny,
                            maxy,
                            minz: maxz,
                            maxz,
                        }),
                        walltype,
                        tiletype: floor,
                        minpoints: "0",
                    })
                )
            );
            await builder.insertElements(player.map, lines);
            player.speak(
                `Built skylight ${walltype}/${floor} at z=${maxz}${player.previewMode ? " (preview)" : ""}.`
            );
        } catch (err) {
            player.speak(`Skylight failed. ${err}`);
        }
    }
    async handleDoorway(player: Player, args: string[]): Promise<void> {
        if (args.length < 3) {
            player.speak("Usage: /doorway <walltype> <tiletype> <minpoints>");
            return;
        }
        await this.handlePlace(player, ["door", ...args]);
    }
    handleWhatAmI(player: Player): void {
        const x = Math.round(player.x);
        const y = Math.round(player.y);
        const z = Math.round(player.z);
        const here = builder.elementsAt(player.map, x, y, z);
        if (here.length === 0) {
            player.speak(`Nothing at ${x}, ${y}, ${z}.`);
            return;
        }
        const parts = here.map((e) => {
            const p = e.properties as any;
            const desc =
                e.elementName === "platform"
                    ? `${p.type} platform`
                    : e.elementName === "zone"
                    ? `zone "${p.innerText ?? ""}"`
                    : e.elementName === "door"
                    ? `${p.walltype}/${p.tiletype} door`
                    : e.elementName;
            return `${desc} (id ${e.id})`;
        });
        player.speak(`At ${x}, ${y}, ${z}: ${parts.join("; ")}.`);
    }
}
