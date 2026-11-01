def auction_access(cursor, auction, viewer):
    """
    Single chokepoint for every access decision in BOTH routers (sales.py and
    auctions.py import this). One rule drives all three modes:

        PADDLE CONTROLS ENTRY. Access mode only decides WHO may OBTAIN a paddle
        (buy it, or be issued one). Bidding always requires holding a paddle.

    The previous version broke this: open/vip granted can_bid WITHOUT a paddle
    (no ticket revenue, and anonymous visitors could bid on open rooms) and
    forbade buying a paddle there; invite told invited users to BUY a free
    paddle. All fixed below. Returned keys are unchanged so no caller breaks
    (one additive key, is_host, is introduced for the owner short-circuit).

    OWNER SHORT-CIRCUIT (added): a house is deliberately forbidden from holding
    a paddle in her own room (issue_paddle), so the honest ticket/invitation
    lookups below return False for the owner of an invite/vip room, which made
    visible=False -> the owner was locked out of her OWN sale (get_sale returned
    "this sale is private"; the floor card rendered her room locked). We now
    force owner-visibility AFTER computing the honest facts, overriding only the
    DERIVED access flags (visible / can_watch / needs_ticket / can_buy_ticket)
    and adding is_host. We never fake has_ticket / is_invited / is_vip / can_bid,
    so the host still cannot bid on her own lots and non-owners are gated
    exactly as before.
    """
    # Canonicalize the tier spellings that have drifted across the codebase
    # (db / auctions.ts use 'vip_only' / 'invite_only'; the verbal model and
    # sales.ts use 'vip' / 'invite'). Without this, a sale stored as tier='vip'
    # fell through to the invite branch and silently vanished from the floor.
    raw = str(auction["tier"] or "open").strip().lower()
    if raw in ("vip", "vip_only"):
        tier = "vip"
    elif raw in ("invite", "invite_only"):
        tier = "invite"
    else:
        tier = "open"  # create_sale defaults the stored value to 'open'; unknown -> open

    # VIP is a TIME fact read from the subscription, never the users.tier cache,
    # so a lapsed membership can't honour a VIP room. (users.tier stays a cheap
    # display cache the navbar pill reads; _sweep_vip re-syncs it authoritatively.)
    is_vip = False
    if viewer:
        cursor.execute(
            "SELECT EXISTS(SELECT 1 FROM vip_subscriptions "
            "WHERE user_name = %s AND status = 'active' AND renews_at > CURRENT_TIMESTAMP) AS vip",
            (viewer,),
        )
        row = cursor.fetchone()
        is_vip = bool(row and row["vip"])

    # Anonymous browsers hold no paddle and no invitation; skip the two lookups
    # (the old code ran them with user_name='' on every logged-out floor card).
    is_invited = False
    has_ticket = False
    if viewer:
        cursor.execute("SELECT 1 FROM invitations WHERE auction_id=%s AND user_name=%s", (auction["id"], viewer))
        is_invited = cursor.fetchone() is not None
        cursor.execute("SELECT 1 FROM tickets WHERE auction_id=%s AND user_name=%s", (auction["id"], viewer))
        has_ticket = cursor.fetchone() is not None

    # Visibility: open + vip are browsable on the floor (vip shows as a locked
    # room to entice subscription); invite is hidden unless you're in it.
    if tier == "invite":
        visible = is_invited or has_ticket
    else:
        visible = True

    # Entry is ALWAYS the paddle. This one line replaces the old per-tier can_bid
    # and, as a side effect, closes two holes the old code had: anonymous bidding
    # on open rooms, and a host bidding on their own lots (neither holds a paddle).
    can_bid = has_ticket
    needs_ticket = visible and not has_ticket

    # Who may OBTAIN a paddle:
    #   open   -> any authenticated user buys
    #   vip    -> only an active VIP buys
    #   invite -> nobody buys; the house ISSUES. An invited user without a paddle
    #             claims a free one instead; the frontend derives that CTA from
    #             (is_invited and not has_ticket and not can_buy_ticket).
    if tier == "open":
        can_buy_ticket = bool(viewer) and not has_ticket
    elif tier == "vip":
        can_buy_ticket = is_vip and not has_ticket
    else:  # invite
        can_buy_ticket = False

    # ----------------------------------------------------------------------
    # OWNER SHORT-CIRCUIT. Compute host identity from the honest facts above,
    # then override ONLY the derived access flags. A host always sees and can
    # enter her own sale (control room / add lots / room), but she must NOT be
    # able to bid (can_bid stays = has_ticket = False) and must NOT be offered
    # a "buy paddle" CTA in her own room (can_buy_ticket forced False), and she
    # does not "need" a paddle (needs_ticket forced False). is_invited /
    # has_ticket / is_vip are left as the truthful lookups so nothing else
    # (e.g. the invited-user free-claim CTA, the VIP pill) is corrupted.
    # ----------------------------------------------------------------------
    host = str((auction or {}).get("host_username") or "").strip()
    v = str(viewer or "").strip()
    is_host = bool(v) and v == host

    if is_host:
        visible = True
        can_watch = True
        needs_ticket = False
        can_buy_ticket = False
        # can_bid intentionally NOT touched: a host must not bid on her own lots.

    return {
        "visible": visible,
        "is_vip": is_vip,
        "is_invited": is_invited,
        "has_ticket": has_ticket,
        "can_bid": can_bid,
        "needs_ticket": needs_ticket,
        "can_buy_ticket": can_buy_ticket,
        "can_watch": visible if not is_host else True,
        "is_host": is_host,
    }