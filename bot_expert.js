// Expert Heuristic Bot for Tyrants of the Underdark
// Usage: add <script src="bot_expert.js"></script> before </body>
// Then call: addExpertBot(playerIndex) e.g. addExpertBot(1)

var EXPERT_PLAYERS = {};
var _expertBusy = false;

function addExpertBot(pi) { EXPERT_PLAYERS[pi] = true; }
function removeExpertBot(pi) { delete EXPERT_PLAYERS[pi]; }
function isExpertTurn() { return EXPERT_PLAYERS[G.currentPlayer]; }

function _expertPlayAll() {
  var p = cp(), pi = G.currentPlayer;
  if (!p.hand || p.hand.length === 0) return null;
  // Optimal order: draw first, then strength, then deploy, then influence
  var best = -1, bestScore = -1;
  for (var i = 0; i < p.hand.length; i++) {
    var card = p.hand[i], score = 0;
    (card.effects || []).forEach(function(e) {
      var v = e.value || 1;
      if (e.type === 'draw') score += 100 * v;
      else if (e.type === 'strength') score += 10 * v;
      else if (e.type === 'deploy') score += 15 * v;
      else if (e.type === 'assassinate') score += 12 * v;
      else if (e.type === 'influence') score += 5 * v;
      else if (e.type === 'choose_one') score += 20;
    });
    if (score > bestScore) { bestScore = score; best = i; }
  }
  if (best >= 0) return { type: 'play', idx: best };
  return { type: 'play', idx: 0 };
}

function _expertBestKill() {
  var pi = G.currentPlayer, best = null, bestScore = -1;
  G.board.forEach(function(node) {
    if (node.nodeType !== 'city') return;
    (node.slots || []).forEach(function(s, si) {
      if (s.owner === null || s.owner === pi) return;
      if (!playerHasPresence(pi, node.id) && s.owner !== 'white') return;
      var score = 0;
      if (s.owner === 'white') score = 1;
      else score = 5;
      score += (node.pz || 1) * 2;
      // Bonus: enemy loses control after kill
      var enemyCount = node.slots.filter(function(sl) { return sl.owner === s.owner; }).length;
      var myCount = node.slots.filter(function(sl) { return sl.owner === pi; }).length;
      if (enemyCount <= 1 && s.owner !== 'white') score += 15;
      if (myCount >= enemyCount) score += 10;
      if (myCount > 0) score += 3;
      if (score > bestScore) { bestScore = score; best = { nid: node.id, si: si }; }
    });
  });
  return best;
}

function _expertBestDeploy(contestedOnly) {
  var pi = G.currentPlayer, best = null, bestScore = -1;
  G.board.forEach(function(node) {
    var hasEmpty = (node.slots || []).some(function(s) { return s.owner === null; });
    if (!hasEmpty) return;
    if (!playerHasPresence(pi, node.id) && hasTroopsOnBoard(pi)) return;
    var score = 0;
    if (node.nodeType === 'city') {
      score = (node.pz || 1) * 3;
      var myCount = node.slots.filter(function(s) { return s.owner === pi; }).length;
      var total = node.slots.filter(function(s) { return s.owner !== null; }).length;
      var hasEnemy = node.slots.some(function(s) { return s.owner !== null && s.owner !== pi && s.owner !== 'white'; });
      if (contestedOnly && !hasEnemy) return;
      if (hasEnemy) score += 10;
      if (myCount >= total - 1 && total > 0) score += 15;
    } else {
      if (contestedOnly) return;
      score = 1;
    }
    if (score > bestScore) { bestScore = score; best = node.id; }
  });
  return best;
}

function _expertBestBuy() {
  var pi = G.currentPlayer, p = cp();
  var allCards = (p.played || []).concat(p.hand || []).concat(p.discard || []);
  var best = -1, bestScore = -1;
  for (var i = 0; i < G.market.length; i++) {
    var card = G.market[i];
    var effectiveCost = card.cost - (G._recruitDiscount || 0);
    if (G.influence < Math.max(0, effectiveCost)) continue;
    var v = (card.cost || 0) * 0.5;
    (card.effects || []).forEach(function(e) {
      var val = e.value || 1, t = e.type || '';
      if (t === 'draw') v += val * 6;
      else if (t === 'deploy') v += val * 5;
      else if (t === 'strength' || t === 'assassinate' || t === 'assassinate_anywhere') v += val * 4;
      else if (t === 'supplant' || t === 'supplant_anywhere' || t === 'supplant_white') v += val * 5;
      else if (t === 'influence') v += val * 2;
      else if (t === 'promote_end_of_turn') v += 5;
      else if (t === 'devour_hand') v += val * 4;
      else if (t.indexOf('forced_discard') >= 0 || t.indexOf('opponents_discard') >= 0) v += val * 3;
      else if (t.indexOf('place_spy') >= 0) v += val * 3;
      else if (t.indexOf('return_enemy') >= 0) v += val * 3;
      else if (t.indexOf('recruit_free') >= 0 || t.indexOf('recruit_budget') >= 0) v += 5;
      else if (t === 'choose_one') v += 3;
      else if (t.indexOf('web') >= 0) v += 2;
    });
    // Focus synergy
    var fs = card.focusSubtype || '', fa = card.focusAspect || '';
    if (fs) { v += allCards.filter(function(c) { return c.deck === fs; }).length * 1.5; }
    else if (fa) { v += allCards.filter(function(c) { return c.aspect === fa; }).length; }
    if (G.round >= 6) v += (card.innerPZ || 0) * 0.5;
    if (v > bestScore) { bestScore = v; best = i; }
  }
  return best >= 0 ? { type: 'market', idx: best } : null;
}

function expertTakeTurn() {
  if (_expertBusy || !isExpertTurn()) return;
  if (G.gameOver) return;
  _expertBusy = true;

  try {
    var pi = G.currentPlayer, p = cp();

    // Setup deploy
    if (G.phase === 'setup_deploy') {
      var startCity = G.board.find(function(n) { return n.nodeType === 'city' && n.starting && n.slots.some(function(s) { return s.owner === null; }); });
      if (startCity) setupDeploy(startCity.id);
      _expertBusy = false;
      setTimeout(function() { if (isExpertTurn() && !G.gameOver) expertTakeTurn(); }, 500);
      return;
    }

    if (G.phase !== 'play') { _expertBusy = false; return; }

    // Handle pending
    if (G.pending) {
      var pt = G.pending.type;
      if (pt === 'deploy') {
        var d = _expertBestDeploy(false);
        if (d) { var node = findNode(d); var si = node.slots.findIndex(function(s) { return s.owner === null; }); if (si >= 0) spendDeploy(d, si); }
        else skipPending();
      } else if (pt.indexOf('assassinate') >= 0) {
        var k = _expertBestKill();
        if (k) spendAssassinate(k.nid, k.si);
        else skipPending();
      } else if (pt.indexOf('place_spy') >= 0) {
        var bestSpy = null, bestSpyScore = -1;
        G.board.forEach(function(n) {
          if (n.nodeType !== 'city') return;
          if ((n.spies || []).includes(pi)) return;
          if (p.spiesInBarracks <= 0) return;
          var score = (n.pz || 1) + n.slots.filter(function(s) { return s.owner !== null && s.owner !== pi && s.owner !== 'white'; }).length * 3;
          if (score > bestSpyScore) { bestSpyScore = score; bestSpy = n.id; }
        });
        if (bestSpy) placeSpy(bestSpy);
        else skipPending();
      } else if (pt === 'choose_one' || pt === 'choose_per_web') {
        // Pick last option (usually stronger)
        var opts = G.pending.options || [];
        if (opts.length > 0) chooseOption(opts.length - 1);
        else skipPending();
      } else if (pt === 'promote' || pt === 'promote_played_discard') {
        // Promote highest innerPZ
        var bestProm = -1, bestPZ = -1;
        (p.played || []).forEach(function(c, i) { if ((c.innerPZ || 0) > bestPZ) { bestPZ = c.innerPZ; bestProm = i; } });
        if (bestProm >= 0) promoteCard(p.played[bestProm].id);
        else skipPending();
      } else if (pt === 'supplant' || pt === 'supplant_white' || pt === 'supplant_anywhere') {
        var k = _expertBestKill();
        if (k) supplant(k.nid, k.si);
        else skipPending();
      } else if (pt === 'devour_hand' || pt === 'madman_discard' || pt === 'poisoned_minion_discard' || pt === 'forced_discard') {
        // Discard cheapest card
        var cheapest = 0, cheapCost = 999;
        (p.hand || []).forEach(function(c, i) { if ((c.cost || 0) < cheapCost) { cheapCost = c.cost || 0; cheapest = i; } });
        if (p.hand.length > 0) {
          var card = p.hand[cheapest];
          if (pt === 'madman_discard') madmanDiscard(card.id);
          else if (pt === 'forced_discard') forcedDiscardAtTurnStart(card.id);
          else if (pt === 'devour_hand') devourHand(cheapest);
          else skipPending();
        } else skipPending();
      } else if (pt === 'return_own_spy') {
        var spyCity = G.board.find(function(n) { return n.nodeType === 'city' && (n.spies || []).includes(pi); });
        if (spyCity) returnOwnSpy(spyCity.id);
        else skipPending();
      } else if (pt === 'return_enemy' || pt === 'return_troop_anywhere') {
        var k = _expertBestKill();
        if (k) returnEnemy(k.nid, k.si);
        else skipPending();
      } else if (pt === 'free_recruit' || pt === 'recruit_budget') {
        var b = _expertBestBuy();
        if (b) buyCard('market', b.idx);
        else skipPending();
      } else {
        skipPending();
      }
      _expertBusy = false;
      setTimeout(function() { if (isExpertTurn() && !G.gameOver) expertTakeTurn(); }, 300);
      return;
    }

    // Normal turn: play cards first
    if (p.hand && p.hand.length > 0) {
      var play = _expertPlayAll();
      if (play) { playCard(p.hand[play.idx].id); _expertBusy = false; setTimeout(function() { if (isExpertTurn() && !G.gameOver) expertTakeTurn(); }, 300); return; }
    }

    // Deploy if str < 3
    if (G.strength >= 1 && G.strength < 3 && p.troopsInBarracks > 0) {
      var d = _expertBestDeploy(true) || _expertBestDeploy(false);
      if (d) { var node = findNode(d); var si = node.slots.findIndex(function(s) { return s.owner === null; }); if (si >= 0) { spendDeploy(d, si); _expertBusy = false; setTimeout(function() { if (isExpertTurn() && !G.gameOver) expertTakeTurn(); }, 300); return; } }
    }

    // Kill if str >= 3
    if (G.strength >= 3) {
      var k = _expertBestKill();
      if (k) { spendAssassinate(k.nid, k.si); _expertBusy = false; setTimeout(function() { if (isExpertTurn() && !G.gameOver) expertTakeTurn(); }, 300); return; }
    }

    // Deploy remaining
    if (G.strength >= 1 && p.troopsInBarracks > 0) {
      var d = _expertBestDeploy(true) || _expertBestDeploy(false);
      if (d) { var node = findNode(d); var si = node.slots.findIndex(function(s) { return s.owner === null; }); if (si >= 0) { spendDeploy(d, si); _expertBusy = false; setTimeout(function() { if (isExpertTurn() && !G.gameOver) expertTakeTurn(); }, 300); return; } }
    }

    // Buy
    if (G.influence > 0) {
      var buy = _expertBestBuy();
      if (buy) { buyCard('market', buy.idx); _expertBusy = false; setTimeout(function() { if (isExpertTurn() && !G.gameOver) expertTakeTurn(); }, 300); return; }
      // Fallback: Kapłanka or Strażnik
      if (G.influence >= 2 && G.lolthSupply > 0) { buyCard('lolth', 0); _expertBusy = false; setTimeout(function() { if (isExpertTurn() && !G.gameOver) expertTakeTurn(); }, 300); return; }
      if (G.influence >= 3 && G.houseGuardSupply > 0) { buyCard('guard', 0); _expertBusy = false; setTimeout(function() { if (isExpertTurn() && !G.gameOver) expertTakeTurn(); }, 300); return; }
    }

    // End turn
    endTurn();
  } catch (e) { console.error('Expert bot error:', e); }

  _expertBusy = false;
  setTimeout(function() { if (isExpertTurn() && !G.gameOver) expertTakeTurn(); }, 500);
}

// Auto-trigger
setInterval(function() { if (!_expertBusy && isExpertTurn() && !G.gameOver) expertTakeTurn(); }, 1000);

console.log('Expert bot loaded. Use addExpertBot(1) to make player 2 a bot.');
