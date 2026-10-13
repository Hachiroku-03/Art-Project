def auction_access(cursor, auction, viewer):
    """
    Single chokepoint for every access decision in BOTH routers (sales.py and
    auctions.py import this). One rule drives all three modes:

        PADDLE CONTROLS ENTRY. Access mode only decides WHO may OBTAIN a paddle
        (buy it, or be issued one). Bidding always requires holding a paddle.

    The previous version broke this: open/vip granted can_bid WITHOUT a paddle
    (no ticket revenue, and anonymous visitors could bid on open rooms) and
    forbade buying a paddle there; invite told invited users to BUY a free
    paddle. All fixed below. Returned keys are unchanged so no caller breaks.
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

    return {
        "visible": visible,
        "is_vip": is_vip,
        "is_invited": is_invited,
        "has_ticket": has_ticket,
        "can_bid": can_bid,
        "needs_ticket": needs_ticket,
        "can_buy_ticket": can_buy_ticket,
        "can_watch": visible,
    }