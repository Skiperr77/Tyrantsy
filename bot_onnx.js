// Tyrants RL Bot — ONNX in-browser inference
// Load with: <script src="https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort.min.js"></script>
// Then: <script src="bot_onnx.js"></script>

var BOT_PLAYERS = {};
var _botBusy = false;
var _botSession = null;
var _botReady = false;

// Constants matching env.py
var BOT_MAX_HAND=10, BOT_MAX_MARKET=8, BOT_MAX_NODES=200, BOT_MAX_SLOTS=6;
var BOT_MAX_PLAYED=15, BOT_MAX_DISCARD=30, BOT_MAX_CHOOSE=4, BOT_MAX_NEIGHBORS=6;
var BOT_NODE_OBS_DIM = 8 + BOT_MAX_NEIGHBORS * 4;
var BOT_ASPECTS = ['Złośliwość','Podbój','Podstęp','Ambicja'];
var BOT_NUMERIC_EFFECTS = ['strength','influence','draw','deploy','assassinate','assassinate_white','supplant','supplant_white','supplant_white_presence','place_spy','place_spy_bonus_strength','promote_end_of_turn','return_enemy','return_own_spy','move_enemy','recruit_madman','recruit_madman_all','devour_hand','devour_market'];
var BOT_CARD_DIM = 3 + BOT_ASPECTS.length + BOT_NUMERIC_EFFECTS.length + 3;

var BOT_OFF_PLAY=0;
var BOT_OFF_BUY=BOT_OFF_PLAY+BOT_MAX_HAND;
var BOT_OFF_DEPLOY=BOT_OFF_BUY+BOT_MAX_MARKET;
var BOT_OFF_KILL=BOT_OFF_DEPLOY+BOT_MAX_NODES;
var BOT_OFF_SPY=BOT_OFF_KILL+BOT_MAX_NODES*BOT_MAX_SLOTS;
var BOT_OFF_SUPPLANT=BOT_OFF_SPY+BOT_MAX_NODES;
var BOT_OFF_PROMOTE=BOT_OFF_SUPPLANT+BOT_MAX_NODES*BOT_MAX_SLOTS;
var BOT_OFF_PROM_DISC=BOT_OFF_PROMOTE+BOT_MAX_PLAYED;
var BOT_OFF_RET_ENEMY=BOT_OFF_PROM_DISC+BOT_MAX_DISCARD;
var BOT_OFF_RET_SPY=BOT_OFF_RET_ENEMY+BOT_MAX_NODES*BOT_MAX_SLOTS;
var BOT_OFF_CHOOSE=BOT_OFF_RET_SPY+BOT_MAX_NODES;
var BOT_OFF_END=BOT_OFF_CHOOSE+BOT_MAX_CHOOSE;
var BOT_OFF_SKIP=BOT_OFF_END+1;
var BOT_NUM_ACTIONS=BOT_OFF_SKIP+1;
var BOT_OBS_DIM=6+BOT_MAX_HAND*BOT_CARD_DIM+BOT_MAX_MARKET*BOT_CARD_DIM+BOT_MAX_NODES*BOT_NODE_OBS_DIM;

function addBot(pi){BOT_PLAYERS[pi]=true;}
function removeBot(pi){delete BOT_PLAYERS[pi];}
function isBotTurn(){return !isOnline?BOT_PLAYERS[G.currentPlayer]:(isHost&&BOT_PLAYERS[G.currentPlayer]);}

async function loadBotModel(url){
  try{
    _botSession=await ort.InferenceSession.create(url, {executionProviders:['wasm']});
    _botReady=true;
    console.log('Bot ONNX model loaded');
  }catch(e){console.error('Failed to load bot model:',e);throw e;}
}

function botCardFeatures(card){
  var f=new Array(BOT_CARD_DIM).fill(0);
  if(!card)return f;
  var idx=0;
  f[idx++]=(card.cost||0)/8;
  f[idx++]=(card.deckPZ||0)/5;
  f[idx++]=(card.innerPZ||0)/10;
  var asp=card.aspect||'';
  for(var a of BOT_ASPECTS){f[idx++]=asp===a?1:0;}
  var em={};
  (card.effects||[]).forEach(function(e){
    if(e.type==='choose_one'){
      var opts=e.options||[];
      if(opts.length)opts.forEach(function(o){(o.effects||[]).forEach(function(oe){em[oe.type]=(em[oe.type]||0)+(oe.value||1)/opts.length;});});
    }else{em[e.type]=(em[e.type]||0)+(e.value||1);}
  });
  for(var en of BOT_NUMERIC_EFFECTS){f[idx++]=(em[en]||0)/5;}
  f[idx++]=(card.effects||[]).some(function(e){return e.type==='choose_one';})?1:0;
  f[idx++]=card.focusAspect?1:0;
  f[idx++]=card.onDiscard?1:0;
  return f;
}

function botBuildObs(){
  var obs=new Float32Array(BOT_OBS_DIM);
  var pi=G.currentPlayer,p=cp();
  var idx=0;
  obs[idx++]=G.strength/10;
  obs[idx++]=G.influence/10;
  obs[idx++]=p.troopsInBarracks/30;
  obs[idx++]=p.spiesInBarracks/5;
  obs[idx++]=p.vpTokens/30;
  obs[idx++]=p.innerCircle.length/10;
  for(var i=0;i<BOT_MAX_HAND;i++){
    var feats=botCardFeatures(i<p.hand.length?p.hand[i]:null);
    for(var j=0;j<BOT_CARD_DIM;j++)obs[idx++]=feats[j];
  }
  for(var i=0;i<6;i++){
    var feats=botCardFeatures(i<G.market.length?G.market[i]:null);
    for(var j=0;j<BOT_CARD_DIM;j++)obs[idx++]=feats[j];
  }
  var gf=botCardFeatures({name:'Strażnik',cost:3,deckPZ:1,innerPZ:3,effects:[{type:'strength',value:2}],aspect:'Podbój'});
  for(var j=0;j<BOT_CARD_DIM;j++)obs[idx++]=gf[j];
  var lf=botCardFeatures({name:'Kapłanka',cost:2,deckPZ:1,innerPZ:2,effects:[{type:'influence',value:2}],aspect:'Ambicja'});
  for(var j=0;j<BOT_CARD_DIM;j++)obs[idx++]=lf[j];
  var nodeOrder=G.board.map(function(n){return n.id;}).slice(0,BOT_MAX_NODES);
  for(var i=0;i<nodeOrder.length;i++){
    var nid=nodeOrder[i],n=findNode(nid);
    if(!n)continue;
    var base=idx+i*BOT_NODE_OBS_DIM;
    var my=0,enemy=0,white=0,empty=0;
    if(n.nodeType==='city'){
      n.slots.forEach(function(s){
        if(s.owner===pi)my++;else if(s.owner===null)empty++;else if(s.owner==='white')white++;else enemy++;
      });
      obs[base]=n.pz/5;
      var ctrl=n.controlledBy;
      obs[base+5]=ctrl===pi?1:(ctrl!==undefined&&ctrl!==null?-1:0);
      var spies=n.spies||[];
      obs[base+6]=spies.filter(function(s){return s===pi;}).length/3;
      obs[base+7]=(spies.length-spies.filter(function(s){return s===pi;}).length)/3;
    }else if(n.nodeType==='spot'){
      if(n.owner===pi)my=1;else if(n.owner===null)empty=1;else if(n.owner==='white')white=1;else enemy=1;
    }
    obs[base+1]=my/BOT_MAX_SLOTS;obs[base+2]=enemy/BOT_MAX_SLOTS;obs[base+3]=white/BOT_MAX_SLOTS;obs[base+4]=empty/BOT_MAX_SLOTS;
    var neighbors=[...(G.adjacency[nid]||[])];
    for(var ni=0;ni<Math.min(neighbors.length,BOT_MAX_NEIGHBORS);ni++){
      var nb=findNode(neighbors[ni]);if(!nb)continue;
      var nb_base=base+8+ni*4;
      if(nb.nodeType==='city')obs[nb_base]=nb.pz/5;
      var nm=0,ne2=0,nemp=0;
      if(nb.nodeType==='city')nb.slots.forEach(function(s){if(s.owner===pi)nm++;else if(s.owner===null)nemp++;else if(s.owner!=='white')ne2++;});
      obs[nb_base+1]=nm/BOT_MAX_SLOTS;obs[nb_base+2]=ne2/BOT_MAX_SLOTS;obs[nb_base+3]=nemp/BOT_MAX_SLOTS;
    }
  }
  return obs;
}

function botBuildMask(){
  var mask=new Float32Array(BOT_NUM_ACTIONS);
  var nodeOrder=G.board.map(function(n){return n.id;}).slice(0,BOT_MAX_NODES);
  var nidx={};nodeOrder.forEach(function(id,i){nidx[id]=i;});
  var actions=_buildLegalActions();
  actions.forEach(function(la){
    var aid=_botGameToAction(la.type,la.params,nidx);
    if(aid>=0&&aid<BOT_NUM_ACTIONS)mask[aid]=1;
  });
  return mask;
}

function _botGameToAction(at,params,nidx){
  if(at==='play')return BOT_OFF_PLAY+(typeof params==='number'?params:0);
  if(at==='buy'){var p=typeof params==='number'?params:0;return BOT_OFF_BUY+(p>=0?p:(p===-1?6:7));}
  if(at==='deploy')return BOT_OFF_DEPLOY+(nidx[params]||0);
  if(at==='assassinate'&&Array.isArray(params))return BOT_OFF_KILL+(nidx[params[0]]||0)*BOT_MAX_SLOTS+params[1];
  if(at==='place_spy')return BOT_OFF_SPY+(nidx[params]||0);
  if(at==='supplant'&&Array.isArray(params))return BOT_OFF_SUPPLANT+(nidx[params[0]]||0)*BOT_MAX_SLOTS+params[1];
  if(at==='promote')return BOT_OFF_PROMOTE+(typeof params==='number'?params:0);
  if(at==='promote_discard')return BOT_OFF_PROM_DISC+(typeof params==='number'?params:0);
  if(at==='return_enemy'&&Array.isArray(params))return BOT_OFF_RET_ENEMY+(nidx[params[0]]||0)*BOT_MAX_SLOTS+params[1];
  if(at==='return_own_spy')return BOT_OFF_RET_SPY+(nidx[params]||0);
  if(at==='return_enemy_spy')return BOT_OFF_RET_SPY+(nidx[params]||0);
  if(at==='choose')return BOT_OFF_CHOOSE+(typeof params==='number'?params:0);
  if(at==='devour_hand'||at==='madman_discard'||at==='forced_discard')return BOT_OFF_PLAY+(typeof params==='number'?params:0);
  if(at==='devour_market')return BOT_OFF_BUY+(typeof params==='number'?params:0);
  if(at==='devour_inner')return BOT_OFF_PROMOTE+(typeof params==='number'?params:0);
  if(at==='end_turn')return BOT_OFF_END;
  if(at==='skip')return BOT_OFF_SKIP;
  return 0;
}

function _botActionToGame(aid){
  var nodeOrder=G.board.map(function(n){return n.id;}).slice(0,BOT_MAX_NODES);
  var nid=function(i){return i>=0&&i<nodeOrder.length?nodeOrder[i]:null;};
  if(aid<BOT_OFF_BUY)return{type:'play',params:aid-BOT_OFF_PLAY};
  if(aid<BOT_OFF_DEPLOY){var i=aid-BOT_OFF_BUY;return{type:'buy',params:i<6?i:(i===6?-1:-2)};}
  if(aid<BOT_OFF_KILL)return{type:'deploy',params:nid(aid-BOT_OFF_DEPLOY)};
  if(aid<BOT_OFF_SPY){var i=aid-BOT_OFF_KILL;return{type:'assassinate',params:[nid(Math.floor(i/BOT_MAX_SLOTS)),i%BOT_MAX_SLOTS]};}
  if(aid<BOT_OFF_SUPPLANT)return{type:'place_spy',params:nid(aid-BOT_OFF_SPY)};
  if(aid<BOT_OFF_PROMOTE){var i=aid-BOT_OFF_SUPPLANT;return{type:'supplant',params:[nid(Math.floor(i/BOT_MAX_SLOTS)),i%BOT_MAX_SLOTS]};}
  if(aid<BOT_OFF_PROM_DISC)return{type:'promote',params:aid-BOT_OFF_PROMOTE};
  if(aid<BOT_OFF_RET_ENEMY)return{type:'promote_discard',params:aid-BOT_OFF_PROM_DISC};
  if(aid<BOT_OFF_RET_SPY){var i=aid-BOT_OFF_RET_ENEMY;return{type:'return_enemy',params:[nid(Math.floor(i/BOT_MAX_SLOTS)),i%BOT_MAX_SLOTS]};}
  if(aid<BOT_OFF_CHOOSE)return{type:'return_own_spy',params:nid(aid-BOT_OFF_RET_SPY)};
  if(aid<BOT_OFF_END)return{type:'choose',params:aid-BOT_OFF_CHOOSE};
  if(aid===BOT_OFF_END)return{type:'end_turn',params:null};
  return{type:'skip',params:null};
}

async function botTakeTurn(){
  if(_botBusy||!isBotTurn()||!_botReady)return;
  _botBusy=true;
  try{
    var obs=botBuildObs();
    var mask=botBuildMask();
    if(mask.reduce(function(a,b){return a+b;},0)===0){_botBusy=false;return;}
    var tensor=new ort.Tensor('float32',obs,[1,BOT_OBS_DIM]);
    var results=await _botSession.run({obs:tensor});
    var logits=results.logits.data;
    // Apply mask: set illegal actions to -Infinity
    var best=-1,bestVal=-Infinity;
    for(var i=0;i<BOT_NUM_ACTIONS;i++){
      if(mask[i]<1)continue;
      if(logits[i]>bestVal){bestVal=logits[i];best=i;}
    }
    if(best>=0){
      var act=_botActionToGame(best);
      _executeBotAction(act);
    }
  }catch(e){console.error('Bot error:',e);}
  _botBusy=false;
  setTimeout(function(){if(isBotTurn()&&!G.gameOver)botTakeTurn();},400);
}


function _buildLegalActions(){
  var actions=[];
  var pi=G.currentPlayer,p=cp();
  if(G.phase!=='play')return actions;
  if(G.pending){
    var pt=G.pending.type;
    if(pt==='deploy'){
      G.board.forEach(function(n){if(n.nodeType!=='city')return;n.slots.forEach(function(s,si){if(s.owner===null)actions.push({type:'deploy',params:n.id});});});
    }else if(pt==='assassinate'||pt==='assassinate_then_discard'){
      G.board.forEach(function(n){if(n.nodeType!=='city')return;n.slots.forEach(function(s,si){if(s.owner!==null&&s.owner!=='white'&&s.owner!==pi&&playerHasPresence(pi,n.id))actions.push({type:'assassinate',params:[n.id,si]});});});
    }else if(pt==='assassinate_white'){
      G.board.forEach(function(n){if(n.nodeType!=='city')return;n.slots.forEach(function(s,si){if(s.owner==='white'&&playerHasPresence(pi,n.id))actions.push({type:'assassinate',params:[n.id,si]});});});
    }else if(pt==='place_spy'||pt==='place_spy_bonus_strength'||pt==='place_spy_control_bonus'){
      G.board.forEach(function(n){if(n.nodeType==='city'&&!(n.spies||[]).includes(pi)&&p.spiesInBarracks>0)actions.push({type:'place_spy',params:n.id});});
    }else if(pt==='promote'){
      p.played.forEach(function(c,i){if(!G.pending.excludeId||c.id!==G.pending.excludeId)actions.push({type:'promote',params:i});});
    }else if(pt==='promote_hand_discard'){
      p.hand.forEach(function(c,i){actions.push({type:'promote',params:i});});
      p.discard.forEach(function(c,i){actions.push({type:'promote_discard',params:i});});
    }else if(pt==='supplant'||pt==='supplant_anywhere'){
      G.board.forEach(function(n){if(n.nodeType!=='city')return;n.slots.forEach(function(s,si){if(s.owner!==null&&s.owner!==pi)actions.push({type:'supplant',params:[n.id,si]});});});
    }else if(pt==='supplant_white'||pt==='supplant_white_presence'){
      G.board.forEach(function(n){if(n.nodeType!=='city')return;n.slots.forEach(function(s,si){if(s.owner==='white')actions.push({type:'supplant',params:[n.id,si]});});});
    }else if(pt==='return_troop'||pt==='return_enemy'){
      G.board.forEach(function(n){if(n.nodeType!=='city')return;n.slots.forEach(function(s,si){if(s.owner!==null&&s.owner!==pi&&s.owner!=='white'&&playerHasPresence(pi,n.id))actions.push({type:'return_enemy',params:[n.id,si]});});});
    }else if(pt==='return_own_spy'){
      G.board.forEach(function(n){if(n.nodeType==='city'&&(n.spies||[]).includes(pi))actions.push({type:'return_own_spy',params:n.id});});
    }else if(pt==='return_enemy_spy'){
      G.board.forEach(function(n){if(n.nodeType!=='city')return;(n.spies||[]).forEach(function(s){if(s!==pi)actions.push({type:'return_enemy_spy',params:n.id});});});
    }else if(pt==='choose_one'||pt==='choose_per_web'){
      (G.pending.options||[]).forEach(function(o,i){actions.push({type:'choose',params:i});});
    }else if(pt==='devour_hand'||pt==='madman_discard'){
      p.hand.forEach(function(c,i){actions.push({type:'devour_hand',params:i});});
    }else if(pt==='recruit_free_max_cost'){
      G.market.forEach(function(c,i){if(c.cost<=G.pending.maxCost)actions.push({type:'buy',params:i});});
    }else if(pt==='forced_discard'){
      p.hand.forEach(function(c,i){actions.push({type:'forced_discard',params:i});});
    }
    actions.push({type:'skip',params:null});
  }else{
    p.hand.forEach(function(c,i){actions.push({type:'play',params:i});});
    G.market.forEach(function(c,i){if(G.influence>=c.cost)actions.push({type:'buy',params:i});});
    if(G.influence>=HOUSE_GUARD.cost)actions.push({type:'buy',params:-1});
    if(G.influence>=LOLTH_PRIESTESS.cost)actions.push({type:'buy',params:-2});
    if(G.strength>=1){
      G.board.forEach(function(n){if(n.nodeType!=='city')return;n.slots.forEach(function(s,si){if(s.owner===null&&(playerHasPresence(pi,n.id)||!hasTroopsOnBoard(pi)))actions.push({type:'deploy',params:n.id});});});
    }
    if(G.strength>=3){
      G.board.forEach(function(n){if(n.nodeType!=='city')return;n.slots.forEach(function(s,si){if(s.owner!==null&&s.owner!==pi&&playerHasPresence(pi,n.id))actions.push({type:'assassinate',params:[n.id,si]});});});
    }
    actions.push({type:'end_turn',params:null});
  }
  return actions;
}

function _executeBotAction(act){
  var t=act.type,p=act.params;
  if(t==='play'&&typeof p==='number'){var card=cp().hand[p];if(card)playCard(card.id);}
  else if(t==='buy'){if(p>=0)buyCard('market',p);else if(p===-1)buyCard('guard',0);else if(p===-2)buyCard('lolth',0);}
  else if(t==='deploy'&&p){var node=findNode(p);if(node){var si=node.slots.findIndex(function(s){return s.owner===null;});if(si>=0)spendDeploy(p,si);}}
  else if(t==='assassinate'&&Array.isArray(p)){spendAssassinate(p[0],p[1]);}
  else if(t==='place_spy'&&p){if(G.pending&&G.pending.type==='place_spy_control_bonus')placeSpyControlBonus(p);else placeSpy(p);}
  else if(t==='supplant'&&Array.isArray(p)){if(G.pending&&(G.pending.type==='supplant_white'||G.pending.type==='supplant_white_presence'))supplantWhite(p[0],p[1]);else if(G.pending&&G.pending.type==='supplant_anywhere')supplantAnywhere(p[0],p[1]);else supplant(p[0],p[1]);}
  else if(t==='promote'&&typeof p==='number'){var card=cp().played[p];if(card)promoteCard(card.id);}
  else if(t==='promote_discard'&&typeof p==='number'){var card=cp().discard[p];if(card)promoteFromDiscard(card.id);}
  else if(t==='return_enemy'&&Array.isArray(p)){if(G.pending&&G.pending.type==='return_troop')spendReturnTroop(p[0],p[1]);else returnEnemy(p[0],p[1]);}
  else if(t==='return_own_spy'&&p){returnOwnSpy(p);}
  else if(t==='return_enemy_spy'&&p){returnEnemySpyOnly(p,null);}
  else if(t==='choose'&&typeof p==='number'){chooseOption(p);}
  else if(t==='devour_hand'&&typeof p==='number'){var card=cp().hand[p];if(card){if(G.pending&&G.pending.type==='madman_discard')madmanDiscard(card.id);}}
  else if(t==='forced_discard'&&typeof p==='number'){var card=cp().hand[p];if(card)forcedDiscardAtTurnStart(card.id);}
  else if(t==='end_turn'){endTurn();}
  else if(t==='skip'){skipPending();}
  if(typeof isOnline!=='undefined'&&isOnline&&typeof isHost!=='undefined'&&isHost&&typeof broadcastState==='function')broadcastState();
}
