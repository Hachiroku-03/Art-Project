def auction_access(cursor, auction, viewer):
    tier = auction["tier"]
    is_vip = False
    if viewer:
        # Monthly: VIP is a TIME fact, not a flag. Read the subscription, not the
        # users.tier cache, so the gate can never honour a lapsed membership.
        # (users.tier still exists as the cheap display cache the navbar pill reads;
        # _sweep_vip() re-syncs it authoritatively on every money/session touch.)
        cursor.execute(
            "SELECT EXISTS(SELECT 1 FROM vip_subscriptions WHERE user_name = %s AND status = 'active' AND renews_at > CURRENT_TIMESTAMP) AS vip",
            (viewer,),
        )
        row = cursor.fetchone()
        is_vip = bool(row and row["vip"])

    cursor.execute("SELECT 1 FROM invitations WHERE auction_id=%s AND user_name=%s", (auction["id"], viewer))
    is_invited = cursor.fetchone() is not None
    cursor.execute("SELECT 1 FROM tickets WHERE auction_id=%s AND user_name=%s", (auction["id"], viewer))
    has_ticket = cursor.fetchone() is not None

    if tier == "invite_only": visible = is_invited or has_ticket
    else: visible = True

    if tier == "open": can_bid, needs_ticket, can_buy_ticket = True, False, False
    elif tier == "vip_only": can_bid, needs_ticket, can_buy_ticket = is_vip, False, False
    else:
        can_bid = has_ticket
        needs_ticket = visible and not has_ticket
        can_buy_ticket = is_invited and not has_ticket

    return {"visible": visible, "is_vip": is_vip, "is_invited": is_invited, "has_ticket": has_ticket, "can_bid": can_bid, "needs_ticket": needs_ticket, "can_buy_ticket": can_buy_ticket, "can_watch": visible}